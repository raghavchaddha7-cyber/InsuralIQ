# InsuralIQ — News Backend

Insurance knowledge platform with a live news aggregation backend.

## Quick Start

```bash
npm install
node server.js
```

Open **http://localhost:3000** — the app loads with live news.

## How It Works

The backend aggregates news from **7 Indian insurance RSS feeds**, auto-tags articles (IRDAI, Life Insurance, Health, Motor, InsurTech, etc.), detects insurance concepts in the text, and serves a clean JSON API.

When RSS feeds are unreachable (e.g. during development), it falls back to **15 curated seed articles** so the app always has content.

News refreshes every **15 minutes** automatically.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/news` | News feed (filterable) |
| `GET /api/tags` | Available tags with counts |
| `GET /api/status` | Health check + feed status |

### Query Parameters for `/api/news`

| Param | Example | Description |
|-------|---------|-------------|
| `tag` | `?tag=IRDAI` | Filter by tag |
| `india` | `?india=true` | India-only stories |
| `limit` | `?limit=20` | Results per page (max 100) |
| `offset` | `?offset=20` | Pagination offset |
| `search` | `?search=surrender` | Full-text search |
| `concepts` | `?concepts=true` | Only articles with detected concepts |

## RSS Feed Sources

- **Economic Times** — Insurance sector
- **Livemint** — Insurance news
- **Moneycontrol** — Insurance + latest news
- **Business Standard** — Finance/Insurance
- **Ditto Insurance** — Educational articles
- **BimaBazaar** — Industry news

## Deploying

### Render.com (free tier)
1. Push to GitHub
2. Connect repo on [render.com](https://render.com)
3. Set build command: `npm install`
4. Set start command: `node server.js`

### Railway / Fly.io
```bash
# Railway
railway init && railway up

# Fly.io
fly launch && fly deploy
```

### Vercel (serverless — needs adaptation)
The current setup is a Node.js server. For Vercel, you'd need to convert to serverless functions.

## Project Structure

```
insuraiq-backend/
├── server.js          # Express server + RSS aggregation
├── public/
│   └── index.html     # Frontend (served by Express)
├── package.json
└── README.md
```

## Adding New Feeds

Edit the `FEEDS` array in `server.js`:

```js
{
  url: "https://example.com/rss-feed.xml",
  source: "Source Name",
  defaultTag: "Insurance",
  india: true,
}
```

## Adding New Concepts

Add to the `KNOWN_CONCEPTS` array in `server.js` for backend detection, and to the `CONCEPTS` object in `public/index.html` for the frontend explainer pop-ups.

---

Built for BIMTECH PGDM IBM · InsuralIQ
