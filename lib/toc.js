import * as cheerio from "cheerio";

const ROMAN_MAP = new Map([
  ["M", 1000],
  ["D", 500],
  ["C", 100],
  ["L", 50],
  ["X", 10],
  ["V", 5],
  ["I", 1],
]);

export function pickBestFormat(formats, prefer = "html") {
  const html = formats?.["text/html; charset=utf-8"] || formats?.["text/html"] || null;
  const text = formats?.["text/plain; charset=utf-8"] || formats?.["text/plain"] || null;
  if (prefer === "text") return { url: text || html, mime: text ? "text/plain" : html ? "text/html" : null };
  return { url: html || text, mime: html ? "text/html" : text ? "text/plain" : null };
}

function romanToNumber(value) {
  const token = String(value || "").trim().toUpperCase();
  if (!/^[IVXLCDM]+$/.test(token)) return null;
  let total = 0;
  let last = 0;
  for (let index = token.length - 1; index >= 0; index -= 1) {
    const current = ROMAN_MAP.get(token[index]) || 0;
    total += current < last ? -current : current;
    last = current;
  }
  return total || null;
}

function normalizeChapterLabel(kind, number, suffix = "") {
  const normalizedKind = kind[0].toUpperCase() + kind.slice(1).toLowerCase();
  const parsedRoman = romanToNumber(number);
  const normalizedNumber = parsedRoman ? `${number.toUpperCase()} (${parsedRoman})` : number;
  const cleanSuffix = String(suffix || "").trim().replace(/^[\W_]+|[\W_]+$/g, "");
  return `${normalizedKind} ${normalizedNumber}${cleanSuffix ? ` - ${cleanSuffix}` : ""}`;
}

function normalizeLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[—–-]{2,}/g, "-")
    .trim();
}

function maybeNormalizeChapterLike(label) {
  const match = label.match(/^(chapter|chap\.?|part|book)\s*[:.\-]?\s*([0-9]+|[ivxlcdm]+)\b[:.\- ]*(.*)$/i);
  if (!match) return label;
  return normalizeChapterLabel(match[1], match[2], match[3]);
}

function uniqStable(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const label = normalizeLabel(item?.label);
    const key = label.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({ ...item, label });
  }
  return output.map((item, order) => ({ ...item, order }));
}

export function extractTocFromText(text, maxItems = 200) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim());

  const idx = lines.findIndex((line) => /^contents$|^table of contents$/i.test(line));
  const source = (idx >= 0 ? lines.slice(idx + 1, idx + 400) : lines.slice(0, 1600)).filter(Boolean);

  const chapterRe = /^(chapter|chap\.?)\s+([0-9]+|[ivxlcdm]+)\b[:.\- ]*(.*)$/i;
  const partRe = /^(part|book)\s+([0-9]+|[ivxlcdm]+)\b[:.\- ]*(.*)$/i;
  const sectionRe = /^(preface|introduction|prologue|epilogue|appendix)\b[:.\- ]*(.*)$/i;

  const toc = [];
  for (const line of source) {
    let match = line.match(chapterRe);
    if (match) {
      toc.push({ label: normalizeChapterLabel("chapter", match[2], match[3]), level: 0, anchor: null, href: null });
    } else {
      match = line.match(partRe);
      if (match) {
        toc.push({ label: normalizeChapterLabel(match[1], match[2], match[3]), level: 0, anchor: null, href: null });
      } else {
        match = line.match(sectionRe);
        if (match) toc.push({ label: `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}${match[2] ? ` - ${match[2].trim()}` : ""}`, level: 0, anchor: null, href: null });
      }
    }
    if (toc.length >= maxItems) break;
  }

  return uniqStable(toc).slice(0, maxItems);
}

export function extractTocFromHtml(html, maxItems = 200) {
  const $ = cheerio.load(String(html));
  const toc = [];

  const contentsHeading = $("h1,h2,h3,h4,h5").filter((_, el) => /contents|table of contents/i.test($(el).text() || "")).first();
  if (contentsHeading.length) {
    contentsHeading.nextAll("ul,ol").first().find("a[href]").each((_, a) => {
      const label = normalizeLabel($(a).text());
      const href = ($(a).attr("href") || "").trim() || null;
      if (!label) return;
      if (/^www\.[\w.-]+\//i.test(label) || /^https?:\/\//i.test(label)) return;
      toc.push({
        label: maybeNormalizeChapterLike(label),
        level: 0,
        href,
        anchor: href && href.startsWith("#") ? href.slice(1) : null,
      });
    });
  }

  if (!toc.length) {
    $("a[href]").each((_, a) => {
      const href = ($(a).attr("href") || "").trim();
      const label = normalizeLabel($(a).text());
      if (!href || !label || label.length > 180) return;
      if (/^www\.[\w.-]+\//i.test(label) || /^https?:\/\//i.test(label)) return;
      if (!/chapter|contents|part|book|appendix|prologue|epilogue/i.test(label)) return;
      toc.push({ label: maybeNormalizeChapterLike(label), level: 0, href, anchor: href.startsWith("#") ? href.slice(1) : null });
    });
  }

  if (!toc.length) {
    const chapterLike = /^(chapter|chap\.?|part|book)\s+([0-9]+|[ivxlcdm]+)\b[:.\- ]*(.*)$/i;
    $("h1,h2,h3").each((_, el) => {
      const label = normalizeLabel($(el).text());
      if (!label) return;
      const match = label.match(chapterLike);
      if (!match) return;
      toc.push({
        label: normalizeChapterLabel(match[1], match[2], match[3]),
        level: 0,
        anchor: ($(el).attr("id") || null),
        href: null,
      });
    });
  }

  return uniqStable(toc).slice(0, maxItems);
}
