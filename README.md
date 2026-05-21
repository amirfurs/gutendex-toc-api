# gutendex-toc-api

Express API for Gutendex/Gutenberg with TOC extraction, paged content slices, and in-book search.

## Endpoints

### Health
- `GET /health`

### Books proxy
- `GET /api/books?search=pride&languages=en&topic=romance&sort=popular&page=1`

### TOC extraction
- `GET /api/books/:id/toc?prefer=html&maxItems=200`
- `prefer`: `html` (default) or `text`
- `maxItems`: max TOC entries (default `200`, max `500`)

Example:
```json
{
  "bookId": 1342,
  "title": "Pride and Prejudice",
  "sourceFormat": "text/html",
  "sourceUrl": "https://...",
  "method": "html-toc-or-headings",
  "toc": [
    { "label": "Chapter I (1)", "level": 0, "anchor": "chap01", "href": "#chap01", "order": 0 }
  ]
}
```

### Content slice
- `GET /api/books/:id/content?offset=0&limit=6000&prefer=text`
- `offset`: start position (default `0`)
- `limit`: chunk size (default `6000`, max `50000`)
- `prefer`: `text` (default) or `html`

Response includes:
- `content`, `offset`, `limit`
- `hasMore`, `nextOffset`
- `totalChars` (when known from full response or `Content-Range`)

### In-book search (new)
- `GET /api/books/:id/search?q=darcy&maxMatches=20&window=80&prefer=text`
- `q` (required): query string
- `maxMatches`: default `20`, max `100`
- `window`: context chars around match (default `80`, max `400`)
- `prefer`: `text` (default) or `html`

Response includes:
- `count`
- `matches[]` with `offset`, `matchLength`, `snippetStart`, `snippetEnd`, `snippet`
- `scannedChars` and `truncated` flags

## Reliability and caching

- All upstream fetches use timeout + retry:
  - timeout: `8s`
  - retries: `2`
  - backoff: `200ms`, then `600ms`
- In-memory LRU + TTL cache:
  - Gutendex metadata (`/books/:id`): `10 min`
  - TOC (`/api/books/:id/toc`): `24 h`
  - Content chunk cache (`/api/books/:id/content`): `30 min` for first chunk (`offset=0`)

## Performance notes

- `/api/books/:id/content` tries HTTP `Range` first (`bytes=offset-end`) to avoid downloading full books.
- If range is unsupported, it falls back to full download + slicing.
- `/api/books/:id/search` streams content and caps scan to `2,500,000` chars to limit memory.
- TOC extraction de-duplicates items while preserving order.

## Run locally

```bash
npm install
npm start
```

## Quick verification (curl)

```bash
curl "http://localhost:10000/health"
curl "http://localhost:10000/api/books?search=pride&languages=en"
curl "http://localhost:10000/api/books/1342/toc?prefer=html&maxItems=60"
curl "http://localhost:10000/api/books/1342/content?offset=0&limit=1200&prefer=text"
curl "http://localhost:10000/api/books/1342/search?q=darcy&maxMatches=5&window=60&prefer=text"
```
