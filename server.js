// ── InsuralIQ News Backend ──────────────────────────────────────
// Aggregates Indian insurance & BFSI news from multiple RSS feeds,
// auto-tags articles, and serves them as a clean JSON API.
// ────────────────────────────────────────────────────────────────

const express = require("express");
const cors = require("cors");
const Parser = require("rss-parser");
const cron = require("node-cron");

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "InsuralIQ/1.0 (Insurance Knowledge Platform)",
  },
});

app.use(cors());

// ── Feed Sources ────────────────────────────────────────────────
// Each source has a URL, a default tag, and whether it's India-focused
const FEEDS = [
  {
    url: "https://economictimes.indiatimes.com/industry/banking/finance/insure/rssfeeds/13358277.cms",
    source: "Economic Times",
    defaultTag: "Insurance",
    india: true,
  },
  {
    url: "https://www.livemint.com/rss/insurance",
    source: "Livemint",
    defaultTag: "Insurance",
    india: true,
  },
  {
    url: "https://www.moneycontrol.com/rss/insurance.xml",
    source: "Moneycontrol",
    defaultTag: "Insurance",
    india: true,
  },
  {
    url: "https://www.business-standard.com/rss/finance/insurance-101.rss",
    source: "Business Standard",
    defaultTag: "Insurance",
    india: true,
  },
  {
    url: "https://joinditto.in/articles/rss/",
    source: "Ditto Insurance",
    defaultTag: "Life Insurance",
    india: true,
  },
  {
    url: "https://bimabazaar.com/feed",
    source: "BimaBazaar",
    defaultTag: "Insurance",
    india: true,
  },
  {
    url: "https://www.moneycontrol.com/rss/latestnews.xml",
    source: "Moneycontrol",
    defaultTag: "BFSI",
    india: true,
  },
];

// ── Auto-tagging Rules ──────────────────────────────────────────
// Keywords → tag mapping, checked against title + description
const TAG_RULES = [
  {
    keywords: ["irdai", "regulator", "regulation", "circular", "compliance", "norms", "mandate"],
    tag: "IRDAI",
    color: "#0E7C86",
  },
  {
    keywords: ["life insurance", "lic", "endowment", "term plan", "surrender", "maturity", "premium", "policyholder"],
    tag: "Life Insurance",
    color: "#FF6B5B",
  },
  {
    keywords: ["health insurance", "cashless", "mediclaim", "hospital", "tpa", "ayushman", "health cover"],
    tag: "Health",
    color: "#7A5CC4",
  },
  {
    keywords: ["motor insurance", "vehicle", "car insurance", "third party", "own damage"],
    tag: "Motor",
    color: "#E0A100",
  },
  {
    keywords: ["insurtech", "digital", "technology", "ai", "startup", "fintech", "bima sugam", "app", "platform"],
    tag: "InsurTech",
    color: "#2A9D8F",
  },
  {
    keywords: ["reinsurance", "global", "lloyd", "swiss re", "munich re", "treaty", "catastrophe"],
    tag: "Global",
    color: "#5B6B70",
  },
  {
    keywords: ["ipo", "stock", "share", "market cap", "listing", "investor", "fdi"],
    tag: "Market",
    color: "#0A5A62",
  },
  {
    keywords: ["claim", "fraud", "settlement", "ombudsman", "grievance", "complaint"],
    tag: "Claims",
    color: "#D35400",
  },
];

// ── Concept Detection ───────────────────────────────────────────
// Terms that can be highlighted as tappable explainers in the frontend
const KNOWN_CONCEPTS = [
  "surrender value",
  "endowment plans",
  "paid-up value",
  "premium",
  "underwriting",
  "actuary",
  "sum assured",
  "term insurance",
  "claim ratio",
  "solvency ratio",
  "reinsurance",
  "third party administrator",
  "cashless claim",
  "rider",
  "maturity benefit",
  "annuity",
  "ulip",
  "indemnity",
  "subrogation",
  "moral hazard",
  "adverse selection",
  "loss ratio",
  "combined ratio",
  "free look period",
  "waiting period",
  "deductible",
  "copayment",
  "insurable interest",
  "nomination",
  "assignment",
];

function detectConcepts(text) {
  const lower = text.toLowerCase();
  return KNOWN_CONCEPTS.filter((c) => lower.includes(c));
}

// ── Tag Assignment ──────────────────────────────────────────────
function assignTag(title, description, defaultTag) {
  const text = `${title} ${description}`.toLowerCase();
  for (const rule of TAG_RULES) {
    if (rule.keywords.some((kw) => text.includes(kw))) {
      return { tag: rule.tag, tagColor: rule.color };
    }
  }
  // Fallback to source default
  const fallback = TAG_RULES.find((r) => r.tag === defaultTag);
  return {
    tag: defaultTag,
    tagColor: fallback?.color || "#5B6B70",
  };
}

// ── Time Formatting ─────────────────────────────────────────────
function timeAgo(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// ── Truncate to a clean sentence boundary ───────────────────────
function truncate(text, maxLen = 160) {
  if (!text) return "";
  // Strip HTML tags
  const clean = text.replace(/<[^>]+>/g, "").trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastPeriod = cut.lastIndexOf(".");
  const lastSpace = cut.lastIndexOf(" ");
  const breakAt = lastPeriod > maxLen * 0.5 ? lastPeriod + 1 : lastSpace;
  return cut.slice(0, breakAt).trim() + "…";
}

// ── Seed Data (fallback when feeds are unavailable) ─────────────
const SEED_ARTICLES = [
  { title: "IRDAI's new surrender value norms: what changed for policyholders", dek: "From 1 October 2024, life insurers must pay a surrender value even if you exit after just one year of premiums — reversing the earlier rule where first-year exits received nothing.", source: "InsuralIQ", link: "#", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "2h ago", concepts: ["surrender value"] },
  { title: "Life insurers roll out revised best-selling products after rule change", dek: "Non-participating endowment plans rebuilt to meet the 2024 product regulations. Premium structures and surrender value tables have been recalculated.", source: "Economic Times", link: "https://economictimes.indiatimes.com", tag: "Life Insurance", tagColor: "#FF6B5B", india: true, time: "5h ago", concepts: ["endowment plans", "premium", "surrender value"] },
  { title: "Cashless everywhere: what the health claim push means for you", dek: "Network hospitals, TPAs and the friction the reform is trying to remove. IRDAI wants every insurer to offer 100% cashless settlement.", source: "Livemint", link: "https://livemint.com", tag: "Health", tagColor: "#7A5CC4", india: true, time: "1d ago", concepts: [] },
  { title: "Global reinsurers signal firmer pricing into 2026", dek: "Why treaty renewals abroad still ripple into Indian premiums. Swiss Re and Munich Re both flagged rising nat-cat losses.", source: "Business Standard", link: "https://business-standard.com", tag: "Global", tagColor: "#5B6B70", india: false, time: "1d ago", concepts: [] },
  { title: "Nine insurers file IPO plans with IRDAI", dek: "In February 2025, nine insurance companies submitted IPO proposals, reflecting growing investor appetite for India's underpenetrated insurance market.", source: "Moneycontrol", link: "https://moneycontrol.com", tag: "Market", tagColor: "#0A5A62", india: true, time: "2d ago", concepts: [] },
  { title: "Bima Sugam goes live: IRDAI's 'UPI of Insurance'", dek: "The unified insurance marketplace launched in September 2025, enabling customers to compare, buy, port and claim across all insurers on a single platform.", source: "Business Standard", link: "https://business-standard.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "2d ago", concepts: [] },
  { title: "India opens insurance sector to 100% FDI", dek: "In a landmark move, the government removed the 74% cap on foreign direct investment. One life insurer and one general insurer have already increased foreign shareholding.", source: "Economic Times", link: "https://economictimes.indiatimes.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "3d ago", concepts: [] },
  { title: "Understanding term insurance: why it should be your first policy", dek: "Term insurance offers the highest life cover at the lowest premium. A ₹1 crore cover can cost as little as ₹700/month for a 25-year-old non-smoker.", source: "Ditto Insurance", link: "https://joinditto.in", tag: "Life Insurance", tagColor: "#FF6B5B", india: true, time: "3d ago", concepts: ["term insurance", "premium"] },
  { title: "How AI is reshaping underwriting in Indian insurance", dek: "From automated risk scoring to satellite imagery for crop insurance — InsurTech startups are cutting underwriting time from weeks to minutes.", source: "BimaBazaar", link: "https://bimabazaar.com", tag: "InsurTech", tagColor: "#2A9D8F", india: true, time: "4d ago", concepts: ["underwriting"] },
  { title: "IRDAI establishes Policyholders' Education and Protection Fund", dek: "The new PEPF framework focuses on insurance literacy, grievance redressal using technology, and recovery of unclaimed insurance amounts.", source: "Moneycontrol", link: "https://moneycontrol.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "4d ago", concepts: [] },
  { title: "What is claim settlement ratio and why it matters", dek: "A higher claim ratio means the insurer pays out more claims. But the number alone doesn't tell the whole story — here's how to read it properly.", source: "Ditto Insurance", link: "https://joinditto.in", tag: "Life Insurance", tagColor: "#FF6B5B", india: true, time: "5d ago", concepts: ["claim ratio"] },
  { title: "Motor insurance: own damage vs third party explained", dek: "Third party cover is mandatory by law, but own damage protects your vehicle. Here's why you need both, and what comprehensive really means.", source: "BimaBazaar", link: "https://bimabazaar.com", tag: "Motor", tagColor: "#E0A100", india: true, time: "5d ago", concepts: [] },
  { title: "IRDAI introduces perpetual registration for insurance intermediaries", dek: "Annual fees replace cumbersome periodic renewals. Authorized salespersons must now be tagged to every proposal and policy for accountability.", source: "Business Standard", link: "https://business-standard.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "6d ago", concepts: [] },
  { title: "Solvency ratio: how to check if your insurer is financially sound", dek: "IRDAI mandates a minimum 150% solvency ratio. Here's what that means and how to look it up before buying a policy.", source: "Livemint", link: "https://livemint.com", tag: "Insurance", tagColor: "#0E7C86", india: true, time: "1w ago", concepts: ["solvency ratio"] },
  { title: "Embedded insurance: buying cover without visiting an insurer", dek: "Travel insurance at flight booking, device protection at checkout — embedded insurance is making cover seamless and accessible.", source: "BimaBazaar", link: "https://bimabazaar.com", tag: "InsurTech", tagColor: "#2A9D8F", india: true, time: "1w ago", concepts: [] },
];

// Add IDs to seed data
SEED_ARTICLES.forEach((a, i) => { a.id = `seed_${i}`; a.pubDate = new Date(Date.now() - i * 3600000 * 12).toISOString(); });

// ── News Store ──────────────────────────────────────────────────
let newsCache = [];
let lastFetchTime = null;
let fetchErrors = [];
let usingSeed = false;

async function fetchAllFeeds() {
  const results = [];
  const errors = [];

  await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        const items = (parsed.items || []).slice(0, 15).map((item) => {
          const { tag, tagColor } = assignTag(
            item.title || "",
            item.contentSnippet || item.content || "",
            feed.defaultTag
          );
          return {
            id: Buffer.from(item.link || item.title || "").toString("base64").slice(0, 20),
            title: item.title || "Untitled",
            dek: truncate(item.contentSnippet || item.content || ""),
            link: item.link || "",
            pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
            time: timeAgo(item.pubDate || item.isoDate || new Date()),
            source: feed.source,
            tag,
            tagColor,
            india: feed.india,
            concepts: detectConcepts(
              `${item.title} ${item.contentSnippet || item.content || ""}`
            ),
          };
        });
        results.push(...items);
      } catch (err) {
        errors.push({ source: feed.source, url: feed.url, error: err.message });
      }
    })
  );

  // Sort by date, newest first
  results.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Deduplicate by title similarity
  const seen = new Set();
  const deduped = results.filter((item) => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  newsCache = deduped;
  lastFetchTime = new Date().toISOString();
  fetchErrors = errors;

  // If no feeds worked, use seed data as fallback
  if (deduped.length === 0 && errors.length > 0) {
    newsCache = [...SEED_ARTICLES];
    usingSeed = true;
    console.log(
      `[${new Date().toLocaleTimeString()}] All ${errors.length} feeds failed — using ${SEED_ARTICLES.length} seed articles`
    );
    errors.forEach((e) => console.log(`  ⚠ ${e.source}: ${e.error}`));
  } else {
    usingSeed = false;
    console.log(
      `[${new Date().toLocaleTimeString()}] Fetched ${deduped.length} articles from ${FEEDS.length - errors.length}/${FEEDS.length} feeds`
    );
    if (errors.length) {
      errors.forEach((e) => console.log(`  ⚠ ${e.source}: ${e.error}`));
    }
  }
}

// ── API Routes ──────────────────────────────────────────────────

// GET /api/news — main feed
// Query params:
//   ?tag=IRDAI          — filter by tag
//   ?india=true         — India-only stories
//   ?limit=20           — number of results (default 20, max 100)
//   ?offset=0           — pagination offset
//   ?search=surrender   — full-text search in title + dek
//   ?concepts=true      — only articles with detected concepts
app.get("/api/news", (req, res) => {
  let items = [...newsCache];

  // Filters
  if (req.query.tag) {
    items = items.filter((i) => i.tag.toLowerCase() === req.query.tag.toLowerCase());
  }
  if (req.query.india === "true") {
    items = items.filter((i) => i.india);
  }
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    items = items.filter(
      (i) => i.title.toLowerCase().includes(q) || i.dek.toLowerCase().includes(q)
    );
  }
  if (req.query.concepts === "true") {
    items = items.filter((i) => i.concepts.length > 0);
  }

  const total = items.length;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;
  items = items.slice(offset, offset + limit);

  res.json({
    ok: true,
    total,
    limit,
    offset,
    lastFetched: lastFetchTime,
    articles: items,
  });
});

// GET /api/tags — available tags with counts
app.get("/api/tags", (req, res) => {
  const counts = {};
  newsCache.forEach((item) => {
    counts[item.tag] = (counts[item.tag] || 0) + 1;
  });
  const tags = Object.entries(counts)
    .map(([tag, count]) => {
      const rule = TAG_RULES.find((r) => r.tag === tag);
      return { tag, count, color: rule?.color || "#5B6B70" };
    })
    .sort((a, b) => b.count - a.count);
  res.json({ ok: true, tags });
});

// GET /api/status — health check
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    articleCount: newsCache.length,
    lastFetched: lastFetchTime,
    feedCount: FEEDS.length,
    feedErrors: fetchErrors.length,
    usingSeedData: usingSeed,
    errors: fetchErrors,
  });
});

// GET / — serve the frontend
app.use(express.static(__dirname + "/public"));

// ── Startup ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`\n  ┌──────────────────────────────────────┐`);
  console.log(`  │   InsuralIQ News API                  │`);
  console.log(`  │   http://localhost:${PORT}              │`);
  console.log(`  │                                        │`);
  console.log(`  │   GET /api/news     — news feed        │`);
  console.log(`  │   GET /api/tags     — tag breakdown    │`);
  console.log(`  │   GET /api/status   — health check     │`);
  console.log(`  └──────────────────────────────────────┘\n`);

  // Initial fetch
  await fetchAllFeeds();

  // Refresh every 15 minutes
  cron.schedule("*/15 * * * *", fetchAllFeeds);
});
