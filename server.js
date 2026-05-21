import express from "express";
import { LruTtlCache, TTL } from "./lib/cache.js";
import { fetchWithTimeoutAndRetry } from "./lib/fetch.js";
import { extractTocFromHtml, extractTocFromText, pickBestFormat } from "./lib/toc.js";

const app = express();
app.disable("x-powered-by");

const GUTENDEX = "https://gutendex.com";
const metadataCache = new LruTtlCache(500);
const tocCache = new LruTtlCache(1000);
const contentCache = new LruTtlCache(500);

function parseTotalBytes(contentRangeHeader) {
  if (!contentRangeHeader) return null;
  const match = String(contentRangeHeader).match(/bytes\s+\d+-\d+\/(\d+|\*)/i);
  if (!match || match[1] === "*") return null;
  return Number(match[1]);
}

async function getBookMetadata(id) {
  const key = `book:${id}`;
  const cached = metadataCache.get(key);
  if (cached) return cached;

  const response = await fetchWithTimeoutAndRetry(`${GUTENDEX}/books/${id}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(response.status === 404 ? "Book not found on Gutendex" : `Metadata fetch failed (${response.status})`);

  const book = await response.json();
  metadataCache.set(key, book, TTL.metadata);
  return book;
}

function buildSearchSnippets(text, query, maxMatches, window) {
  const qLower = query.toLowerCase();
  const tLower = text.toLowerCase();
  const matches = [];
  let cursor = 0;

  while (matches.length < maxMatches) {
    const idx = tLower.indexOf(qLower, cursor);
    if (idx < 0) break;
    const snippetStart = Math.max(0, idx - window);
    const snippetEnd = Math.min(text.length, idx + query.length + window);
    matches.push({
      offset: idx,
      matchLength: query.length,
      snippetStart,
      snippetEnd,
      snippet: text.slice(snippetStart, snippetEnd),
    });
    cursor = idx + Math.max(1, query.length);
  }

  return matches;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/books", async (req, res) => {
  const search = (req.query.search ?? "").toString();
  const languages = (req.query.languages ?? "en").toString();
  const topic = (req.query.topic ?? "").toString();
  const sort = (req.query.sort ?? "popular").toString();
  const page = Number(req.query.page ?? 1);

  const url = new URL(`${GUTENDEX}/books`);
  if (search) url.searchParams.set("search", search);
  if (languages) url.searchParams.set("languages", languages);
  if (topic) url.searchParams.set("topic", topic);
  if (sort) url.searchParams.set("sort", sort);
  if (page) url.searchParams.set("page", String(page));

  try {
    const r = await fetchWithTimeoutAndRetry(url, { headers: { Accept: "application/json" } });
    const j = await r.json().catch(() => null);
    return res.status(r.ok ? 200 : 502).json(j ?? { error: "Invalid JSON from upstream" });
  } catch (e) {
    return res.status(502).json({ error: e?.message ?? "Search proxy failed" });
  }
});

app.get("/api/books/:id/content", async (req, res) => {
  const id = Number(req.params.id);
  const prefer = (req.query.prefer ?? "text").toString();
  const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
  const limit = Math.min(Math.max(1, Number(req.query.limit ?? 6000) || 6000), 50000);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const book = await getBookMetadata(id);
    const { url: sourceUrl, mime } = pickBestFormat(book?.formats || {}, prefer);
    if (!sourceUrl || !mime) return res.status(404).json({ error: "No readable format available" });

    const cacheKey = `content:${id}:${prefer}:${offset}:${limit}`;
    if (offset === 0) {
      const cached = contentCache.get(cacheKey);
      if (cached) {
        res.set("Cache-Control", "public, max-age=300");
        return res.json(cached);
      }
    }

    const rangeEnd = offset + limit - 1;
    const rangeResponse = await fetchWithTimeoutAndRetry(sourceUrl, {
      headers: { Accept: "*/*", Range: `bytes=${offset}-${rangeEnd}` },
    });

    let content = "";
    let totalChars = null;

    if (rangeResponse.status === 206) {
      content = await rangeResponse.text();
      totalChars = parseTotalBytes(rangeResponse.headers.get("content-range"));
    } else if (rangeResponse.status === 200) {
      const fullBody = await rangeResponse.text();
      content = fullBody.slice(offset, offset + limit);
      totalChars = fullBody.length;
    } else if (rangeResponse.status === 416) {
      content = "";
      totalChars = parseTotalBytes(rangeResponse.headers.get("content-range")) ?? 0;
    } else {
      return res.status(502).json({ error: `Failed to fetch book content (${rangeResponse.status})` });
    }

    const hasMore = totalChars == null ? content.length >= limit : offset + content.length < totalChars;
    const nextOffset = hasMore ? offset + content.length : null;

    const payload = {
      bookId: id,
      title: book?.title || `Book ${id}`,
      sourceFormat: mime === "text/html" ? "text/html" : "text/plain",
      sourceUrl,
      offset,
      limit,
      totalChars,
      content,
      hasMore,
      nextOffset,
    };

    if (offset === 0) contentCache.set(cacheKey, payload, TTL.content);
    res.set("Cache-Control", "public, max-age=300");
    return res.json(payload);
  } catch (e) {
    const message = e?.message ?? "Content fetch failed";
    return res.status(/not found/i.test(message) ? 404 : 502).json({ error: message });
  }
});

app.get("/api/books/:id/toc", async (req, res) => {
  const id = Number(req.params.id);
  const maxItems = Math.min(Number(req.query.maxItems ?? 200) || 200, 500);
  const prefer = (req.query.prefer ?? "html").toString();
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const cacheKey = `toc:${id}:${prefer}:${maxItems}`;
    const cached = tocCache.get(cacheKey);
    if (cached) {
      res.set("Cache-Control", "public, max-age=300");
      return res.json(cached);
    }

    const book = await getBookMetadata(id);
    const { url: sourceUrl, mime } = pickBestFormat(book?.formats || {}, prefer);
    if (!sourceUrl || !mime) return res.status(404).json({ error: "No readable format available" });

    const textRes = await fetchWithTimeoutAndRetry(sourceUrl, { headers: { Accept: "*/*" } });
    if (!textRes.ok) return res.status(502).json({ error: `Failed to fetch book content (${textRes.status})` });
    const body = await textRes.text();

    let toc = [];
    let method = "unknown";
    let sourceFormat = "unknown";
    if (mime === "text/html") {
      toc = extractTocFromHtml(body, maxItems);
      method = toc.length ? "html-toc-or-headings" : "html-no-toc-found";
      sourceFormat = "text/html";
    } else {
      toc = extractTocFromText(body, maxItems);
      method = toc.length ? "text-contents-or-regex" : "text-no-toc-found";
      sourceFormat = "text/plain";
    }

    const payload = {
      bookId: id,
      title: book?.title || `Book ${id}`,
      sourceFormat,
      sourceUrl,
      method,
      toc,
    };
    tocCache.set(cacheKey, payload, TTL.toc);
    res.set("Cache-Control", "public, max-age=300");
    return res.json(payload);
  } catch (e) {
    const message = e?.message ?? "TOC extraction failed";
    return res.status(/not found/i.test(message) ? 404 : 502).json({ error: message });
  }
});

app.get("/api/books/:id/search", async (req, res) => {
  const id = Number(req.params.id);
  const q = (req.query.q ?? "").toString().trim();
  const maxMatches = Math.min(Math.max(Number(req.query.maxMatches ?? 20) || 20, 1), 100);
  const window = Math.min(Math.max(Number(req.query.window ?? 80) || 80, 20), 400);
  const prefer = (req.query.prefer ?? "text").toString();

  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  if (!q) return res.status(400).json({ error: "Missing q query parameter" });

  try {
    const book = await getBookMetadata(id);
    const { url: sourceUrl, mime } = pickBestFormat(book?.formats || {}, prefer);
    if (!sourceUrl || !mime) return res.status(404).json({ error: "No readable format available" });

    const response = await fetchWithTimeoutAndRetry(sourceUrl, { headers: { Accept: "*/*" } });
    if (!response.ok) return res.status(502).json({ error: `Failed to fetch book content (${response.status})` });

    const MAX_SCAN_CHARS = 2_500_000;
    let scanned = "";
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      scanned = (await response.text()).slice(0, MAX_SCAN_CHARS);
    } else {
      while (scanned.length < MAX_SCAN_CHARS) {
        const { done, value } = await reader.read();
        if (done) break;
        scanned += decoder.decode(value, { stream: true });
        if (buildSearchSnippets(scanned, q, maxMatches, window).length >= maxMatches) break;
      }
      scanned += decoder.decode();
      if (scanned.length > MAX_SCAN_CHARS) scanned = scanned.slice(0, MAX_SCAN_CHARS);
    }

    const matches = buildSearchSnippets(scanned, q, maxMatches, window);
    return res.json({
      bookId: id,
      title: book?.title || `Book ${id}`,
      sourceFormat: mime,
      sourceUrl,
      query: q,
      maxMatches,
      window,
      scannedChars: scanned.length,
      truncated: scanned.length >= MAX_SCAN_CHARS,
      count: matches.length,
      matches,
    });
  } catch (e) {
    const message = e?.message ?? "Search failed";
    return res.status(/not found/i.test(message) ? 404 : 502).json({ error: message });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Listening on ${port}`));
