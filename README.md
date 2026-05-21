# gutendex-toc-api

Tiny Express API to:
- Search Gutendex books (proxy): `GET /api/books`
- Extract a **Table of Contents (TOC)** for a Gutendex/Gutenberg book id: `GET /api/books/:id/toc`

## Endpoints

### Health
- `GET /health`

### Search (optional proxy)
- `GET /api/books?search=pride&languages=en&topic=romance&sort=popular&page=1`

### Extract TOC
- `GET /api/books/1342/toc?prefer=html&maxItems=200`

Response example:
```json
{
  "bookId": 1342,
  "title": "Pride and Prejudice",
  "sourceFormat": "text/html",
  "sourceUrl": "https://...",
  "method": "html-toc-or-headings",
  "toc": [
    {"label": "Chapter 1", "level": 0, "anchor": null, "href": null, "order": 0}
  ]
}
```

## Deploy to Render

1. Create a new **Web Service** from this repo.
2. Environment: **Node**
3. Build command: `npm install`
4. Start command: `npm start`

Render provides `PORT` automatically.
