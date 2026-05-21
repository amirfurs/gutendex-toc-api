import express from "express";
import * as cheerio from "cheerio";

const app = express();
app.disable("x-powered-by");

const GUTENDEX = "https://gutendex.com";

function pickBestFormat(formats, prefer = "html") {
  const html = formats?.["text/html; charset=utf-8"] || formats?.["text/html"] || null;
  const text = formats?.["text/plain; charset=utf-8"] || formats?.["text/plain"] || null;

  if (prefer === "text") {
    return {
      url: text || html,
      mime: text ? "text/plain" : html ? "text/html" : null,
    };
  }

  return {
    url: html || text,
    mime: html ? "text/html" : text ? "text/plain" : null,
  };
}

function uniqByLabel(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = String(it?.label ?? "").trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function extractTocFromText(txt, maxItems = 200) {
  const lines = String(txt)
    .split(/\r?\n/)
    .map((l) => l.trim());

  // Prefer: section after a "CONTENTS" header if present
  const idx = lines.findIndex((l) => /^contents$/i.test(l) || /^table of contents$/i.test(l));
  const preferred = idx !== -1 ? lines.slice(idx + 1, idx + 250).filter(Boolean) : [];

  const toc = [];
  const chapterRe = /^(chapter|chap\.?)[\s]+([0-9]+|[ivxlcdm]+)\b[:.\- ]*(.*)$/i;
  const partRe = /^(part|book)[\s]+([0-9]+|[ivxlcdm]+)\b[:.\- ]*(.*)$/i;
  const sectionRe = /^(preface|introduction|prologue|epilogue|appendix)\b[:.\- ]*(.*)$/i;

  const source = preferred.length ? preferred : lines.slice(0, 1200);

  for (const l of source) {
    if (!l) continue;

    let m;
    if ((m = l.match(chapterRe))) {
      toc.push({
        label: `Chapter ${m[2]}${m[3] ? ` — ${m[3].trim()}` : ""}`,
        level: 0,
        anchor: null,
        href: null,
      });
    } else if ((m = l.match(partRe))) {
      const kind = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      toc.push({
        label: `${kind} ${m[2]}${m[3] ? ` — ${m[3].trim()}` : ""}`,
        level: 0,
        anchor: null,
        href: null,
      });
    } else if ((m = l.match(sectionRe))) {
      const kind = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      toc.push({
        label: `${kind}${m[2] ? ` — ${m[2].trim()}` : ""}`,
        level: 0,
        anchor: null,
        href: null,
      });
    }

    if (toc.length >= maxItems) break;
  }

  return uniqByLabel(toc).map((it, i) => ({ ...it, order: i }));
}

function extractTocFromHtml(html, maxItems = 200) {
  const $ = cheerio.load(String(html));
  const toc = [];

  // 1) Try explicit TOC blocks (heading contains "Contents") then next list
  const contentsHeadings = $("h1,h2,h3,h4,h5").filter((_, el) => /contents|table of contents/i.test($(el).text() || ""));

  if (contentsHeadings.length) {
    const h = contentsHeadings.first();
    const list = h.nextAll("ul,ol").first();
    if (list.length) {
      list.find("a").each((_, a) => {
        const label = ($(a).text() || "").trim();
        const href = (($(a).attr("href") || "").trim()) || null;
        if (!label) return;
        toc.push({
          label,
          level: 0,
          anchor: href && href.startsWith("#") ? href.slice(1) : null,
          href,
        });
      });
    }
  }

  // 2) Fallback: scan headings that look like chapters
  if (!toc.length) {
    const re = /^(chapter|chap\.?)[\s]+([0-9]+|[ivxlcdm]+)\b/i;
    $("h1,h2,h3").each((_, el) => {
      const t = (($(el).text() || "").trim());
      if (!t) return;
      if (!re.test(t)) return;
      toc.push({
        label: t,
        level: 0,
        anchor: ($(el).attr("id") || null),
        href: null,
      });
    });
  }

  return uniqByLabel(toc).slice(0, maxItems).map((it, i) => ({ ...it, order: i }));
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Proxy search (optional helper for GPT actions)
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

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const j = await r.json().catch(() => null);
  res.status(r.ok ? 200 : 502).json(j ?? { error: "Invalid JSON from upstream" });
});

// Extract TOC
app.get("/api/books/:id/toc", async (req, res) => {
  const id = Number(req.params.id);
  const maxItems = Math.min(Number(req.query.maxItems ?? 200) || 200, 500);
  const prefer = (req.query.prefer ?? "html").toString(); // html|text

  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const metaRes = await fetch(`${GUTENDEX}/books/${id}`, { headers: { Accept: "application/json" } });
    if (!metaRes.ok) return res.status(404).json({ error: "Book not found on Gutendex" });

    const book = await metaRes.json();
    const { url: sourceUrl, mime } = pickBestFormat(book?.formats || {}, prefer);
    if (!sourceUrl || !mime) return res.status(404).json({ error: "No readable format available" });

    const textRes = await fetch(sourceUrl, { headers: { Accept: "*/*" } });
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

    res.set("Cache-Control", "public, max-age=300");
    return res.json({
      bookId: id,
      title: book?.title || `Book ${id}`,
      sourceFormat,
      sourceUrl,
      method,
      toc,
    });
  } catch (e) {
    return res.status(502).json({ error: e?.message ?? "TOC extraction failed" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Listening on ${port}`));
