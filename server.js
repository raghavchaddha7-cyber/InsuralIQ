// ── InsuralIQ News Backend ──────────────────────────────────────
// Dual-API news engine:
//   1. NewsData.io  (primary)  — 200 credits/day, rotated queries
//   2. APITube.io   (secondary) — 1000 req/day, insurance-focused
// Both feed into a unified relevance gate + quality pipeline.
// ────────────────────────────────────────────────────────────────

const express = require("express");
const cors = require("cors");
const Parser = require("rss-parser");
const cron = require("node-cron");

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
});

app.use(cors());

// ── API Keys ──────────────────────────────────────────────────
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || "";
const APITUBE_API_KEY = process.env.APITUBE_API_KEY || "";

// ── Source Quality Control ─────────────────────────────────────
// STRATEGY: Blocklist + stricter relevance for unknown sources.
// A whitelist killed results (NewsData.io free tier doesn't index
// all premium domains). Instead we:
//  1. Block known junk/spam domains
//  2. Accept articles from known trusted domains with 2+ keyword matches
//  3. Accept articles from unknown domains with 3+ keyword matches
//     (higher bar = less risk of irrelevant content slipping through)

const TRUSTED_DOMAINS = new Set([
  "economictimes.indiatimes.com", "economictimes.com",
  "livemint.com",
  "moneycontrol.com",
  "business-standard.com",
  "thehindubusinessline.com",
  "ndtvprofit.com", "ndtv.com",
  "reuters.com",
  "financialexpress.com",
  "insurancedekho.com",
  "policybazaar.com",
  "bimabazaar.com",
  "asiainsurancereview.com",
  "insurancetimes.co.uk",
  "theinsurancetimes.in",
  "covermagazine.co.uk",
  "hindustantimes.com",
  "thehindu.com",
  "deccanherald.com",
  "news18.com",
  "india.com",
  "outlookindia.com",
  "firstpost.com",
  "zeebiz.com",
  "cnbctv18.com",
  "bloombergquint.com",
]);

const BLOCKED_DOMAINS = new Set([
  "youtube.com", "twitter.com", "x.com", "facebook.com",
  "instagram.com", "reddit.com", "tiktok.com",
  "pinterest.com", "quora.com", "medium.com",
  "blogspot.com", "wordpress.com", "tumblr.com",
  "wikipedia.org",
]);

function isDomainTrusted(sourceUrl) {
  if (!sourceUrl) return false;
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
    return TRUSTED_DOMAINS.has(host);
  } catch { return false; }
}

function isDomainBlocked(sourceUrl) {
  if (!sourceUrl) return false;
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
    return BLOCKED_DOMAINS.has(host);
  } catch { return false; }
}

// Search queries — strictly insurance-focused (uses 1 credit each)
// Queries are ROTATED — only 2 run per cycle to conserve credits
const NEWSDATA_QUERIES = [
  { q: "insurance IRDAI India", label: "Insurance + IRDAI" },
  { q: "life insurance OR health insurance India", label: "Life + Health Insurance" },
  { q: "motor insurance OR crop insurance OR reinsurance India", label: "Motor + Crop + Reinsurance" },
  { q: "insurtech OR insurance company OR insurance policy India", label: "InsurTech + Companies" },
  { q: "LIC OR \"HDFC Life\" OR \"ICICI Prudential\" OR \"Star Health\" insurance", label: "Major Insurers" },
  { q: "insurance acquisition OR insurance FDI OR insurer merger India", label: "M&A + FDI" },
  { q: "\"Bajaj Allianz\" OR \"SBI Life\" OR \"IndiaFirst\" OR \"Digit\" insurance", label: "More Insurers" },
];

// ── Query Rotation State ──────────────────────────────────────
// Runs 2 queries per 15-min cycle, rotating through all 7.
// Full rotation every ~1 hour. Uses ~192 credits/day (within 200 limit).
let queryRotationIndex = 0;
const QUERIES_PER_CYCLE = 2;

// ── RSS Feed Sources (fallback) ────────────────────────────────
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

// ── Relevance Gate ─────────────────────────────────────────────
// 200+ insurance keywords — the most comprehensive filter possible.
// An article must match 2+ keywords (trusted source) or 3+ (unknown
// source) to appear on InsuralIQ. This is what keeps quality high.
const INSURANCE_KEYWORDS = [
  // ── Core insurance terms ──
  "insurance", "insurer", "insured", "insuring", "insurers",
  "insurance policy", "insurance cover", "insurance plan",
  "insurance premium", "insurance claim", "insurance sector",
  "insurance industry", "insurance market", "insurance business",
  "insurance company", "insurance regulation", "insurance act",
  "insurance penetration", "insurance density", "insurance fraud",

  // ── Regulator & governance ──
  "irdai", "irda", "insurance regulatory",
  "policyholder", "policy holder", "policyholders",
  "claim settlement", "claim ratio", "claims paid",
  "solvency ratio", "solvency margin", "capital adequacy",
  "loss ratio", "combined ratio", "incurred claim ratio",
  "grievance redressal", "ombudsman", "insurance ombudsman",
  "bima sugam", "bima vistaar", "bima vahak",

  // ── Life insurance ──
  "life insurance", "life insurer", "life cover",
  "term plan", "term insurance", "term life",
  "endowment", "endowment plan", "money back plan",
  "ulip", "unit linked", "pension plan", "annuity",
  "whole life", "child plan", "retirement plan",
  "sum assured", "sum insured", "death benefit",
  "maturity benefit", "survival benefit", "bonus",
  "surrender value", "paid-up", "paid up value",
  "nomination", "assignment", "free look period",
  "mortality charge", "fund value", "nav",
  "participating plan", "non-participating",

  // ── Health insurance ──
  "health insurance", "health cover", "health plan",
  "mediclaim", "cashless", "cashless claim",
  "hospitalisation", "hospitalization", "hospital",
  "tpa", "third party administrator",
  "pre-existing", "pre existing disease", "waiting period",
  "copayment", "co-payment", "deductible", "sub-limit",
  "daycare procedure", "domiciliary", "room rent",
  "no claim bonus", "cumulative bonus",
  "top-up plan", "super top-up", "critical illness",
  "personal accident", "group health",
  "ayushman bharat", "ayushman", "pmjay", "ab-pmjay",
  "niva bupa", "star health", "care health",
  "arogya sanjeevani", "health id",

  // ── Motor insurance ──
  "motor insurance", "vehicle insurance", "car insurance",
  "two wheeler insurance", "bike insurance",
  "third party", "own damage", "comprehensive cover",
  "idv", "insured declared value", "zero depreciation",
  "no claim bonus", "ncb", "add-on cover",
  "roadside assistance", "engine protection",
  "motor vehicles act", "motor tariff",

  // ── General / specialty insurance ──
  "general insurance", "non-life insurance",
  "fire insurance", "marine insurance", "cargo insurance",
  "crop insurance", "pmfby", "pradhan mantri fasal bima",
  "weather insurance", "parametric insurance",
  "travel insurance", "home insurance", "property insurance",
  "cyber insurance", "cyber risk", "data breach insurance",
  "liability insurance", "professional indemnity",
  "product liability", "directors and officers",
  "engineering insurance", "construction insurance",
  "aviation insurance", "satellite insurance",
  "credit insurance", "trade credit", "surety bond",
  "title insurance", "pet insurance", "warranty insurance",
  "embedded insurance", "sachet insurance",
  "microinsurance", "group insurance", "takaful",

  // ── Reinsurance ──
  "reinsurance", "reinsurer", "treaty", "facultative",
  "retrocession", "catastrophe bond", "cat bond",
  "excess of loss", "quota share", "proportional treaty",
  "gic re", "swiss re", "munich re", "lloyd",
  "scor", "hannover re", "berkshire hathaway",

  // ── Distribution & intermediary ──
  "insurance agent", "insurance broker", "insurance intermediary",
  "corporate agent", "web aggregator", "posp",
  "point of sale person", "bancassurance", "banca",
  "insurance distribution", "agency channel",
  "policybazaar", "insurancedekho", "coverfox",
  "turtlemint", "ditto insurance",

  // ── Underwriting & actuarial ──
  "underwriting", "underwriter", "underwritten",
  "actuary", "actuarial", "risk assessment",
  "risk scoring", "risk pricing", "mortality table",
  "morbidity", "experience rating", "rate making",
  "risk pooling", "risk selection", "adverse selection",
  "moral hazard", "insurable interest", "utmost good faith",
  "subrogation", "indemnity", "contribution",
  "proximate cause", "material fact",

  // ── InsurTech & digital ──
  "insurtech", "insuretech", "insurance technology",
  "digital insurance", "telematics", "usage based",
  "pay as you drive", "pay how you drive",
  "ai in insurance", "machine learning insurance",
  "blockchain insurance", "smart contract insurance",
  "robo advisory", "chatbot insurance",
  "acko", "go digit", "digit insurance", "toffee insurance",
  "plum insurance", "razorpay insurance", "onsurity",

  // ── Major Indian insurers ──
  "lic", "life insurance corporation",
  "hdfc life", "hdfc ergo", "icici prudential", "icici lombard",
  "sbi life", "sbi general", "bajaj allianz",
  "tata aia", "max life", "kotak life", "kotak general",
  "new india assurance", "united india insurance",
  "oriental insurance", "national insurance company",
  "reliance general", "future generali", "royal sundaram",
  "iffco tokio", "universal sompo", "shriram general",
  "aditya birla health", "aditya birla sun life",
  "canara hsbc", "exide life", "ageas federal",
  "pramerica", "aegon", "aviva", "bharti axa",
  "indiaFirst life", "indiafirst",
  "bnp paribas cardif", "edelweiss tokio",

  // ── International insurers ──
  "allianz", "axa", "zurich insurance", "prudential",
  "metlife", "generali", "manulife", "sun life",
  "chubb", "aig", "marsh", "aon", "willis towers",

  // ── Market & M&A ──
  "insurance ipo", "insurer ipo", "lic ipo", "insurance listing",
  "fdi in insurance", "foreign direct investment insurance",
  "insurance acquisition", "insurer merger",
  "insurance stake", "insurance joint venture",
  "insurance valuation", "embedded value",

  // ── Risk & claims ──
  "risk cover", "risk management", "risk transfer",
  "risk mitigation", "enterprise risk",
  "claim denied", "claim rejected", "claim fraud",
  "insurance fraud", "claim process",

  // ── Premium & financial terms ──
  "premium", "premiums", "gross written premium",
  "net premium", "renewal premium", "single premium",
  "regular premium", "limited premium",
  "rider", "riders", "add-on", "add-ons",
];

function isInsuranceRelevant(title, description, content) {
  const text = `${title} ${description} ${content}`.toLowerCase();
  // Count how many insurance keywords appear
  let matchCount = 0;
  for (const kw of INSURANCE_KEYWORDS) {
    if (text.includes(kw)) matchCount++;
  }
  // Need at least 2 insurance keyword matches to be considered relevant
  return matchCount >= 2;
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

// ── Strip HTML tags ────────────────────────────────────────────
function stripHtml(text) {
  if (!text) return "";
  return text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

// ── Truncate to a clean sentence boundary ───────────────────────
function truncate(text, maxLen = 160) {
  if (!text) return "";
  const clean = stripHtml(text);
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastPeriod = cut.lastIndexOf(".");
  const lastSpace = cut.lastIndexOf(" ");
  const breakAt = lastPeriod > maxLen * 0.5 ? lastPeriod + 1 : lastSpace;
  return cut.slice(0, breakAt).trim() + "…";
}

// ── Clean & Enhance Summary ────────────────────────────────────
// Removes junk patterns from API/RSS content to create clean summaries
function cleanSummary(text) {
  if (!text) return "";
  let clean = stripHtml(text);
  // Remove common junk patterns from news APIs
  clean = clean.replace(/\(Also read:.*?\)/gi, "");
  clean = clean.replace(/Also read:.*?$/gim, "");
  clean = clean.replace(/READ MORE:.*?$/gim, "");
  clean = clean.replace(/ALSO READ.*?$/gim, "");
  clean = clean.replace(/Click here to.*?$/gim, "");
  clean = clean.replace(/Subscribe to.*?$/gim, "");
  clean = clean.replace(/Follow us on.*?$/gim, "");
  clean = clean.replace(/Sign up for.*?$/gim, "");
  clean = clean.replace(/Download the.*?app.*?$/gim, "");
  clean = clean.replace(/\[.*?\]/g, ""); // Remove [Reuters], [PTI] etc
  clean = clean.replace(/\(Reuters\)/gi, "");
  clean = clean.replace(/\(PTI\)/gi, "");
  clean = clean.replace(/\(IANS\)/gi, "");
  clean = clean.replace(/\(ANI\)/gi, "");
  // Clean up whitespace
  clean = clean.replace(/\s+/g, " ").trim();
  return clean;
}

// ── Extract full content from RSS item ─────────────────────────
function extractFullContent(item) {
  // Try content:encoded first (richest), then content, then contentSnippet
  const raw = item["content:encoded"] || item.content || item.contentSnippet || "";
  const clean = stripHtml(raw);
  // If we have substantial content, return it
  if (clean.length > 200) return clean;
  // Otherwise, build from what we have
  const snippet = stripHtml(item.contentSnippet || "");
  const content = stripHtml(item.content || "");
  // Return the longer one
  return content.length > snippet.length ? content : snippet;
}

// ── Seed Data (fallback when feeds are unavailable) ─────────────
const SEED_ARTICLES = [
  { title: "IRDAI's new surrender value norms: what changed for policyholders", dek: "From 1 October 2024, life insurers must pay a surrender value even if you exit after just one year of premiums — reversing the earlier rule where first-year exits received nothing.", fullContent: "The Insurance Regulatory and Development Authority of India (IRDAI) has introduced sweeping changes to surrender value norms that took effect on 1 October 2024. Under the old framework, policyholders who exited a life insurance policy within the first year received nothing — their entire premium was forfeited. The new regulations mandate that insurers pay a surrender value even after just one year of premium payments. This is a landmark shift that protects millions of policyholders who may need to exit early due to financial hardship or changing circumstances.\n\nThe reform introduces two key calculations: the Guaranteed Surrender Value (GSV), which is a fixed percentage of premiums paid — roughly 30% in the second year, rising progressively to about 90% in the final policy years; and the Special Surrender Value (SSV), which is calculated based on the policy's paid-up value and the ratio of premiums paid to total premiums due. The policyholder receives whichever value is higher.\n\nThe regulation also requires insurers to clearly disclose surrender value tables at the point of sale, so buyers know exactly what they'd receive if they exit at any point during the policy term. Industry experts estimate that this reform will make insurance products more transparent and consumer-friendly, potentially boosting policy persistence rates across the sector.", source: "InsuralIQ", link: "#", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "2h ago", concepts: ["surrender value", "premium", "paid-up value"] },
  { title: "Life insurers roll out revised best-selling products after rule change", dek: "Non-participating endowment plans rebuilt to meet the 2024 product regulations. Premium structures and surrender value tables have been recalculated.", fullContent: "Major life insurance companies including LIC, SBI Life, HDFC Life, and ICICI Prudential have begun rolling out revised versions of their best-selling endowment and savings plans following IRDAI's 2024 product regulation overhaul. The changes primarily affect non-participating endowment plans — policies where the sum assured and bonuses are guaranteed, as opposed to participating plans where returns depend on the insurer's investment performance.\n\nThe revised products feature recalculated premium structures to account for the new surrender value norms. Since insurers must now pay higher surrender values in early policy years, they've adjusted the premium loading to maintain profitability. For consumers, this means slightly higher premiums in some cases, but significantly better exit options if they need to discontinue the policy.\n\nSurrender value tables have been completely overhauled across all major insurers. Under the new framework, a policyholder exiting a 20-year endowment plan after 5 years can expect to receive approximately 50-55% of premiums paid as surrender value, compared to 30-35% under the old norms. The changes also mandate that insurers provide a surrender value illustration at the point of sale, making it easier for consumers to compare products across companies.\n\nIndustry analysts note that these changes could fundamentally shift consumer behavior, with more buyers opting for traditional savings plans now that the 'lock-in risk' has been significantly reduced.", source: "Economic Times", link: "https://economictimes.indiatimes.com", tag: "Life Insurance", tagColor: "#FF6B5B", india: true, time: "5h ago", concepts: ["endowment plans", "premium", "surrender value"] },
  { title: "Cashless everywhere: what the health claim push means for you", dek: "Network hospitals, TPAs and the friction the reform is trying to remove. IRDAI wants every insurer to offer 100% cashless settlement.", fullContent: "IRDAI has been pushing aggressively for universal cashless health insurance claims, aiming to eliminate the reimbursement model that has long been a pain point for policyholders. Under the current system, patients often have to pay hospital bills upfront and then file for reimbursement — a process that can take weeks and involves extensive paperwork.\n\nThe new directive requires all health insurers to offer cashless settlement at every network hospital. This means the insurer pays the hospital directly, and the policyholder only pays any amount not covered by the policy. Third Party Administrators (TPAs), who manage claims processing on behalf of insurers, are being required to upgrade their technology systems for real-time claim authorization.\n\nThe reform also addresses the issue of hospitals inflating bills for insured patients. IRDAI has proposed standardized treatment cost packages, similar to the Ayushman Bharat model, to bring transparency to hospital billing. Additionally, insurers will be required to settle cashless claims within 3 hours for planned hospitalizations and immediately for emergencies.\n\nFor consumers, the key takeaway is that cashless claims should become smoother and faster. However, experts advise policyholders to always verify that their preferred hospital is in the insurer's network before admission, as network agreements can change.", source: "Livemint", link: "https://livemint.com", tag: "Health", tagColor: "#7A5CC4", india: true, time: "1d ago", concepts: ["cashless claim"] },
  { title: "Global reinsurers signal firmer pricing into 2026", dek: "Why treaty renewals abroad still ripple into Indian premiums. Swiss Re and Munich Re both flagged rising nat-cat losses.", fullContent: "Global reinsurance giants Swiss Re and Munich Re have both signaled that they expect firmer pricing conditions heading into 2026 treaty renewals, driven by rising natural catastrophe losses worldwide. While this may seem like a distant international development, it has direct implications for Indian insurance premiums.\n\nReinsurance is essentially insurance for insurance companies — primary insurers transfer portions of their risk to reinsurers to protect their balance sheets. When reinsurance prices rise globally, Indian insurers face higher costs for their risk transfer programs, which they typically pass on to policyholders through premium increases.\n\nSwiss Re reported that global insured losses from natural catastrophes exceeded $100 billion for the fourth consecutive year, with severe weather events in Asia contributing significantly. Munich Re highlighted that secondary perils such as flooding and hailstorms — which are increasing in frequency due to climate change — are driving much of the loss growth.\n\nFor India specifically, rising reinsurance costs could impact crop insurance premiums under the Pradhan Mantri Fasal Bima Yojana (PMFBY), as well as property and catastrophe insurance rates. GIC Re, India's sole domestic reinsurer, may also need to adjust its pricing to reflect the global trend.", source: "Business Standard", link: "https://business-standard.com", tag: "Global", tagColor: "#5B6B70", india: false, time: "1d ago", concepts: ["reinsurance", "premium"] },
  { title: "Nine insurers file IPO plans with IRDAI", dek: "In February 2025, nine insurance companies submitted IPO proposals, reflecting growing investor appetite for India's underpenetrated insurance market.", fullContent: "Nine insurance companies filed IPO proposals with IRDAI in February 2025, marking a significant wave of potential public listings in the sector. The companies include a mix of life and general insurers, reflecting growing investor appetite for India's insurance market — which remains significantly underpenetrated compared to global averages.\n\nIndia's insurance penetration stands at approximately 4% of GDP, compared to the global average of 7%, suggesting enormous growth potential. This underpenetration, combined with rising awareness, increasing disposable incomes, and digital distribution channels, has made insurance stocks attractive to both domestic and foreign investors.\n\nThe IPO candidates are reportedly looking to raise a combined ₹15,000-20,000 crores through their listings. Industry observers note that the recent strong performance of listed insurers — SBI Life, HDFC Life, ICICI Prudential Life, and Star Health — has encouraged other companies to explore the public markets.\n\nIRDAI has streamlined the IPO approval process for insurers, requiring companies to meet minimum solvency margins, maintain clean compliance records, and demonstrate consistent profitable operations over at least three years before going public.", source: "Moneycontrol", link: "https://moneycontrol.com", tag: "Market", tagColor: "#0A5A62", india: true, time: "2d ago", concepts: ["solvency ratio"] },
  { title: "Bima Sugam goes live: IRDAI's 'UPI of Insurance'", dek: "The unified insurance marketplace launched in September 2025, enabling customers to compare, buy, port and claim across all insurers on a single platform.", fullContent: "Bima Sugam, often described as the 'UPI of Insurance,' went live in September 2025 after months of development and testing. The platform is IRDAI's ambitious vision for a unified insurance marketplace that brings together all life, health, and general insurers on a single digital platform.\n\nThe platform allows consumers to compare insurance products across all registered insurers, purchase policies online, port existing policies to a different insurer, and file and track claims — all from one interface. It also provides a centralized repository of all policies held by an individual, solving the common problem of policyholders losing track of their coverage.\n\nFor intermediaries and agents, Bima Sugam offers a standardized digital onboarding process and a common platform for policy issuance. Insurance companies are required to list all their products on the platform with standardized feature descriptions, making it easier for consumers to make apple-to-apple comparisons.\n\nThe claims process has been significantly simplified — policyholders or their nominees can file claims through the platform regardless of which insurer issued the policy. The platform also integrates with hospitals for health insurance cashless claims and with motor accident databases for vehicle insurance.\n\nIndustry experts believe Bima Sugam could transform insurance distribution in India the way UPI transformed payments, making insurance more accessible, transparent, and consumer-friendly.", source: "Business Standard", link: "https://business-standard.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "2d ago", concepts: [] },
  { title: "India opens insurance sector to 100% FDI", dek: "In a landmark move, the government removed the 74% cap on foreign direct investment. One life insurer and one general insurer have already increased foreign shareholding.", fullContent: "In a landmark liberalization move, the Indian government removed the 74% cap on foreign direct investment (FDI) in the insurance sector, allowing 100% foreign ownership of insurance companies operating in India. This decision, announced as part of the Union Budget, represents the final step in a gradual opening that began with a 26% cap in 2000, was raised to 49% in 2015, and then to 74% in 2021.\n\nThe change comes with certain conditions — insurers with majority foreign ownership must ensure that a significant portion of their profits is reinvested in India, and key management personnel must include Indian nationals. The Insurance Act amendments also require that these companies maintain adequate solvency margins and meet all domestic regulatory requirements.\n\nAt least two insurers have already begun the process of increasing their foreign shareholding beyond the previous 74% limit. Industry sources indicate that several global insurance giants, including Allianz, AXA, and Zurich Insurance, are exploring full ownership of their Indian joint ventures.\n\nThe move is expected to bring additional foreign capital, global best practices, and advanced technology into India's insurance sector. However, some domestic industry players have expressed concerns about increased competition and the potential marginalization of Indian promoter partners in existing joint ventures.\n\nAnalysts project that the 100% FDI allowance could attract $5-8 billion in additional foreign investment into Indian insurance over the next 3-5 years.", source: "Economic Times", link: "https://economictimes.indiatimes.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "3d ago", concepts: ["solvency ratio"] },
  { title: "Understanding term insurance: why it should be your first policy", dek: "Term insurance offers the highest life cover at the lowest premium. A ₹1 crore cover can cost as little as ₹700/month for a 25-year-old non-smoker.", fullContent: "Term insurance is the simplest and most affordable form of life insurance — it provides pure risk cover without any savings or investment component. If the policyholder dies during the policy term, the nominee receives the full sum assured. If the policyholder survives the term, no payout is made (unless it's a return-of-premium variant, which costs more).\n\nHere's why financial planners universally recommend term insurance as your first policy: A 25-year-old non-smoker can get ₹1 crore of life cover for approximately ₹700-900 per month, depending on the insurer. The same ₹1 crore cover through an endowment plan would cost ₹35,000-45,000 per month — making term insurance nearly 50 times more cost-effective for pure protection.\n\nWhen choosing a term plan, consider these factors: First, the cover amount should be at least 10-15 times your annual income to adequately protect your family. Second, the policy term should extend until your planned retirement age (typically 60-65). Third, compare claim settlement ratios across insurers — this tells you what percentage of death claims the insurer actually pays out.\n\nCommon add-ons (riders) worth considering include critical illness cover, accidental death benefit, and waiver of premium (which keeps the policy active even if you become disabled and can't pay premiums).\n\nOne important consideration: term insurance premiums increase significantly with age, so buying early locks in lower rates for the entire policy duration. A policy bought at age 25 can cost 40-50% less than the same cover bought at age 35.", source: "Ditto Insurance", link: "https://joinditto.in", tag: "Life Insurance", tagColor: "#FF6B5B", india: true, time: "3d ago", concepts: ["term insurance", "premium", "claim ratio", "sum assured"] },
  { title: "How AI is reshaping underwriting in Indian insurance", dek: "From automated risk scoring to satellite imagery for crop insurance — InsurTech startups are cutting underwriting time from weeks to minutes.", fullContent: "Artificial intelligence is fundamentally transforming the underwriting process in Indian insurance, reducing what was once a weeks-long manual process to minutes of automated assessment. Several InsurTech startups and established insurers are deploying AI across the underwriting value chain.\n\nIn life insurance, AI-powered underwriting engines now analyze applicants' health data, lifestyle factors, and even social media patterns to assess risk profiles. Companies like Acko and Digit have introduced 'instant issue' policies where AI makes the underwriting decision in real-time, eliminating the need for physical medical examinations for lower-risk applicants.\n\nCrop insurance has seen perhaps the most dramatic transformation. Satellite imagery combined with AI models can now assess crop health, predict yield losses, and trigger automatic payouts — a process called parametric insurance. Under the Pradhan Mantri Fasal Bima Yojana (PMFBY), several states are piloting satellite-based crop cutting experiments that replace the traditional manual process.\n\nIn motor insurance, telematics devices and smartphone sensors track driving behavior to create personalized risk profiles. Good drivers can receive premium discounts of 15-25% based on their actual driving data.\n\nHowever, the use of AI in underwriting raises important ethical questions about algorithmic bias and data privacy. IRDAI has issued guidelines requiring insurers to ensure that AI-based underwriting does not discriminate against applicants based on factors like geography, gender, or socioeconomic background.", source: "BimaBazaar", link: "https://bimabazaar.com", tag: "InsurTech", tagColor: "#2A9D8F", india: true, time: "4d ago", concepts: ["underwriting", "premium"] },
  { title: "IRDAI establishes Policyholders' Education and Protection Fund", dek: "The new PEPF framework focuses on insurance literacy, grievance redressal using technology, and recovery of unclaimed insurance amounts.", fullContent: "IRDAI has established the Policyholders' Education and Protection Fund (PEPF), a dedicated framework aimed at improving insurance literacy across India and protecting consumer interests. The fund consolidates resources previously scattered across multiple initiatives into a single, well-funded program.\n\nThe PEPF has three primary objectives: First, to conduct nationwide insurance literacy campaigns through digital and traditional media, reaching underserved populations in rural and semi-urban areas. Second, to deploy technology-driven grievance redressal mechanisms, including an AI-powered chatbot that can help policyholders understand their rights and file complaints. Third, to identify and recover unclaimed insurance amounts — industry estimates suggest that over ₹20,000 crores in insurance benefits remain unclaimed across the sector.\n\nThe fund will be financed through contributions from insurers, calculated as a percentage of their premium collections. IRDAI has mandated that all insurers contribute to the fund and actively participate in literacy programs.\n\nThe PEPF also introduces a 'Policyholder Advocate' program, where trained volunteers in each district help consumers understand insurance products, compare options, and file claims or complaints. This grassroots approach is designed to complement the digital initiatives and reach populations that may not have internet access.", source: "Moneycontrol", link: "https://moneycontrol.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "4d ago", concepts: ["premium"] },
  { title: "What is claim settlement ratio and why it matters", dek: "A higher claim ratio means the insurer pays out more claims. But the number alone doesn't tell the whole story — here's how to read it properly.", fullContent: "The Claim Settlement Ratio (CSR) is one of the most widely cited metrics when comparing insurance companies, but understanding what it actually means — and its limitations — is crucial for making informed decisions.\n\nCSR represents the percentage of claims an insurer settles (pays out) versus the total claims received in a financial year. For example, if an insurer received 100 death claims and paid 97, its CSR is 97%. LIC consistently leads with a CSR above 98%, while private insurers typically range between 95-98%.\n\nHowever, CSR alone doesn't tell the complete story. Here's what to look beyond: First, check the claims repudiation ratio — what percentage of claims were rejected and why. Common rejection reasons include non-disclosure of pre-existing conditions, policy lapse due to non-payment of premiums, and claims falling outside the policy's scope. Second, look at the average time taken to settle claims. An insurer with a 98% CSR that takes 6 months to pay is arguably worse than one with 96% CSR that pays within 30 days.\n\nThe Incurred Claim Ratio (ICR) is another useful metric — it measures the total claims paid as a percentage of total premiums collected. A very high ICR might indicate that the insurer is paying out more than it's collecting, which could impact its long-term solvency. A very low ICR might suggest the insurer is too aggressive in rejecting claims.\n\nWhen choosing an insurer, look at CSR as one factor among many — also consider the company's solvency ratio, product features, premium competitiveness, and customer service reputation.", source: "Ditto Insurance", link: "https://joinditto.in", tag: "Life Insurance", tagColor: "#FF6B5B", india: true, time: "5d ago", concepts: ["claim ratio", "premium", "solvency ratio"] },
  { title: "Motor insurance: own damage vs third party explained", dek: "Third party cover is mandatory by law, but own damage protects your vehicle. Here's why you need both, and what comprehensive really means.", fullContent: "Motor insurance in India has two main components, and understanding the difference is essential for every vehicle owner. Third Party (TP) insurance is mandatory under the Motor Vehicles Act — driving without it is illegal and attracts heavy penalties. Own Damage (OD) insurance is optional but highly recommended.\n\nThird Party insurance covers your legal liability if your vehicle causes injury, death, or property damage to a third party. It does NOT cover any damage to your own vehicle. If you're in an accident and the other person's car is damaged, or worse, someone is injured, your TP insurance pays the compensation. The premium for TP insurance is fixed by IRDAI and is the same across all insurers.\n\nOwn Damage insurance covers damage to your own vehicle from accidents, theft, fire, natural disasters, and vandalism. The premium for OD cover varies between insurers based on the vehicle's Insured Declared Value (IDV), the car's make and model, your location, and your claims history. No Claim Bonus (NCB) — a discount you earn for each claim-free year — can reduce your OD premium by up to 50%.\n\nA Comprehensive policy combines both TP and OD coverage in a single policy. This is what most vehicle owners should opt for. Some insurers also offer add-ons like zero depreciation cover (which pays the full cost of replacement parts without deducting depreciation), roadside assistance, engine protection, and return-to-invoice cover.\n\nKey tip: When renewing your motor insurance, always compare quotes from multiple insurers. While TP premiums are standardized, OD premiums can vary significantly — sometimes by 20-30% for the same coverage.", source: "BimaBazaar", link: "https://bimabazaar.com", tag: "Motor", tagColor: "#E0A100", india: true, time: "5d ago", concepts: ["premium", "deductible"] },
  { title: "IRDAI introduces perpetual registration for insurance intermediaries", dek: "Annual fees replace cumbersome periodic renewals. Authorized salespersons must now be tagged to every proposal and policy for accountability.", fullContent: "IRDAI has introduced a perpetual registration framework for insurance intermediaries — agents, brokers, corporate agents, and web aggregators — replacing the previous system of periodic license renewals. Under the old framework, intermediaries had to renew their licenses every three years, involving significant paperwork and processing time.\n\nThe new system works like a 'lifetime registration' model where intermediaries pay an annual fee to maintain their active status, rather than going through a full renewal process. This reduces administrative burden on both the intermediaries and IRDAI, while maintaining regulatory oversight through annual compliance checks.\n\nA significant accountability measure accompanies this reform: every insurance proposal and policy must now be tagged to a specific authorized salesperson. This creates a clear audit trail linking each policy sale to the person who sold it, making it easier to trace mis-selling and fraudulent practices.\n\nInsurers are required to maintain a real-time database of their authorized salespersons, with details accessible to IRDAI's supervisory team. If a salesperson is found to have engaged in mis-selling, both the individual and the insurer can be held accountable.\n\nThe reform also introduces standardized training and certification requirements for all intermediaries, with mandatory continuing education credits to maintain their registration.", source: "Business Standard", link: "https://business-standard.com", tag: "IRDAI", tagColor: "#0E7C86", india: true, time: "6d ago", concepts: [] },
  { title: "Solvency ratio: how to check if your insurer is financially sound", dek: "IRDAI mandates a minimum 150% solvency ratio. Here's what that means and how to look it up before buying a policy.", fullContent: "The solvency ratio is one of the most important indicators of an insurance company's financial health, yet most policyholders never check it before buying a policy. Understanding this metric can protect you from the risk of your insurer being unable to pay your claim.\n\nThe solvency ratio measures the ratio of an insurer's available capital (Available Solvency Margin, or ASM) to its required capital (Required Solvency Margin, or RSM). IRDAI mandates a minimum solvency ratio of 150% — meaning the insurer must hold at least 1.5 times the capital needed to cover its expected obligations.\n\nA solvency ratio of 150% means the insurer has a 50% buffer above the minimum capital required. A ratio of 200% means it has double the required capital. While a higher ratio generally indicates greater financial stability, an extremely high ratio (say 400%+) might also suggest the insurer is being too conservative and not deploying capital efficiently.\n\nHow to check: Every insurer is required to publish its solvency ratio quarterly. You can find it in the company's annual reports, on IRDAI's website, or on the insurer's own website under financial disclosures. Insurance comparison websites also often list solvency ratios alongside other metrics.\n\nAmong listed life insurers, most maintain solvency ratios between 180-220%. LIC's solvency ratio is typically around 185-190%, while private insurers like HDFC Life and Max Life often maintain ratios above 200%.\n\nBottom line: before buying any insurance policy, especially a long-term one, check the insurer's solvency ratio. While IRDAI's regulatory framework makes insurer insolvency very unlikely in India, a strong solvency ratio provides additional peace of mind.", source: "Livemint", link: "https://livemint.com", tag: "Insurance", tagColor: "#0E7C86", india: true, time: "1w ago", concepts: ["solvency ratio"] },
  { title: "Embedded insurance: buying cover without visiting an insurer", dek: "Travel insurance at flight booking, device protection at checkout — embedded insurance is making cover seamless and accessible.", fullContent: "Embedded insurance is one of the fastest-growing distribution channels in Indian insurance, seamlessly integrating insurance products into the purchase journey of other products and services. Instead of separately visiting an insurer or broker, consumers are offered relevant insurance cover at the exact moment they need it.\n\nThe most familiar examples include travel insurance offered during flight bookings on platforms like MakeMyTrip and Cleartrip, mobile screen protection offered during smartphone purchases on Amazon and Flipkart, and ride insurance offered by Uber and Ola during cab bookings.\n\nThe model works through API integrations between insurance companies and e-commerce or service platforms. When you buy a flight ticket, the booking platform's system connects with an insurer's API to generate a customized travel insurance quote in real-time. The entire process — from quote to purchase to policy issuance — happens in seconds, with the insurance premium often bundled into the overall transaction.\n\nFor insurers, embedded insurance dramatically reduces customer acquisition costs. Traditional insurance sales involve agents, branch offices, and marketing spend. Embedded distribution piggybacks on existing customer relationships and purchase decisions, reaching consumers who might never have sought out insurance independently.\n\nIRDAI has been supportive of this distribution model, issuing guidelines for 'sachet' insurance products — small-ticket, short-duration policies specifically designed for embedded distribution. These products typically cover specific risks for limited periods (a single flight, a 12-month device warranty, a single ride) and are priced at ₹10-500.\n\nIndustry projections suggest that embedded insurance could account for 15-20% of all general insurance premium in India by 2028, up from approximately 3-4% currently.", source: "BimaBazaar", link: "https://bimabazaar.com", tag: "InsurTech", tagColor: "#2A9D8F", india: true, time: "1w ago", concepts: ["premium"] },
];

// Add IDs to seed data
SEED_ARTICLES.forEach((a, i) => { a.id = `seed_${i}`; a.pubDate = new Date(Date.now() - i * 3600000 * 12).toISOString(); });

// ── Curated Articles (added by admin) ─────────────────────────
// These are high-priority articles added manually by the editor
// They always appear and are never filtered out
let curatedArticles = [];
// Curated articles auto-expire after 48 hours.
// Add fresh ones via the admin panel at /admin

// Admin password — set via environment variable for security
const ADMIN_KEY = process.env.ADMIN_KEY || "insuraiq2026";

// ── News Store ──────────────────────────────────────────────────
let newsCache = [];
let lastFetchTime = null;
let fetchErrors = [];
let usingSeed = false;
let newsSource = "none"; // "api", "rss", "seed"

// ── NewsData.io API Fetch (with rotation + domain filter) ─────
async function fetchFromNewsDataAPI() {
  if (!NEWSDATA_API_KEY) return [];

  const results = [];
  const https = require("https");

  // Pick the next QUERIES_PER_CYCLE queries from the rotation
  const queriesToRun = [];
  for (let i = 0; i < QUERIES_PER_CYCLE; i++) {
    queriesToRun.push(NEWSDATA_QUERIES[queryRotationIndex]);
    queryRotationIndex = (queryRotationIndex + 1) % NEWSDATA_QUERIES.length;
  }

  console.log(`  🔄 Running queries ${queriesToRun.map(q => q.label).join(" + ")} (rotation ${queryRotationIndex}/${NEWSDATA_QUERIES.length})`);

  for (const query of queriesToRun) {
    try {
      // No domain= filter — we use blocklist + relevance gate instead
      const url = `https://newsdata.io/api/1/latest?apikey=${NEWSDATA_API_KEY}&q=${encodeURIComponent(query.q)}&country=in&language=en&size=10`;

      const data = await new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 15000 }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error("Invalid JSON response"));
            }
          });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
      });

      if (data.status === "success" && data.results) {
        let accepted = 0, rejected = 0, blocked = 0;
        for (const item of data.results) {
          const title = item.title || "";
          const description = item.description || "";
          const content = item.content || item.description || "";
          const articleUrl = item.link || "";

          // ── BLOCK known junk domains ──
          if (isDomainBlocked(articleUrl)) {
            blocked++;
            continue;
          }

          // ── RELEVANCE GATE ──
          // Trusted sources: need 2+ insurance keywords
          // Unknown sources: need 3+ (higher bar for credibility)
          const trusted = isDomainTrusted(articleUrl);
          const threshold = trusted ? 2 : 3;
          const text = `${title} ${description} ${content}`.toLowerCase();
          let matchCount = 0;
          for (const kw of INSURANCE_KEYWORDS) {
            if (text.includes(kw)) matchCount++;
            if (matchCount >= threshold) break; // early exit
          }
          if (matchCount < threshold) {
            rejected++;
            continue;
          }

          const { tag, tagColor } = assignTag(title, description, "Insurance");

          const cleanContent = cleanSummary(content) || cleanSummary(description);
          results.push({
            id: (item.article_id || Buffer.from(title).toString("base64").slice(0, 20)),
            title: title,
            dek: truncate(cleanSummary(description), 160),
            fullContent: cleanContent,
            link: articleUrl,
            pubDate: item.pubDate || new Date().toISOString(),
            time: timeAgo(item.pubDate || new Date()),
            source: "InsuralIQ",
            tag,
            tagColor,
            india: true,
            trusted,
            concepts: detectConcepts(`${title} ${cleanContent}`),
          });
          accepted++;
        }
        console.log(`  ✅ API query "${query.label}": ${accepted} accepted, ${rejected} irrelevant, ${blocked} blocked`);
      } else if (data.status === "error") {
        console.log(`  ⚠ API query "${query.label}": ${data.results?.message || "Error"}`);
      }
    } catch (err) {
      console.log(`  ⚠ API query "${query.label}": ${err.message}`);
    }
  }
  return results;
}

// ── APITube.io Search Queries ─────────────────────────────────
// Comprehensive insurance-focused queries for the secondary API.
// APITube supports title= parameter for keyword search.
// We rotate through these to maximize coverage.
const APITUBE_QUERIES = [
  { title: "insurance IRDAI", label: "Insurance + IRDAI" },
  { title: "life insurance India", label: "Life Insurance" },
  { title: "health insurance India", label: "Health Insurance" },
  { title: "motor insurance India", label: "Motor Insurance" },
  { title: "insurtech India", label: "InsurTech" },
  { title: "reinsurance India", label: "Reinsurance" },
  { title: "insurance claim settlement", label: "Claims" },
  { title: "insurance premium India", label: "Premiums" },
  { title: "crop insurance PMFBY", label: "Crop Insurance" },
  { title: "insurance FDI acquisition", label: "M&A + FDI" },
];

let apitubeRotationIndex = 0;
const APITUBE_QUERIES_PER_CYCLE = 3; // 3 queries per cycle

// ── APITube.io API Fetch ──────────────────────────────────────
async function fetchFromAPITube() {
  if (!APITUBE_API_KEY) return [];

  const results = [];
  const https = require("https");

  // Pick next queries from rotation
  const queriesToRun = [];
  for (let i = 0; i < APITUBE_QUERIES_PER_CYCLE; i++) {
    queriesToRun.push(APITUBE_QUERIES[apitubeRotationIndex]);
    apitubeRotationIndex = (apitubeRotationIndex + 1) % APITUBE_QUERIES.length;
  }

  console.log(`  🔄 APITube queries: ${queriesToRun.map(q => q.label).join(" + ")}`);

  for (const query of queriesToRun) {
    try {
      const params = new URLSearchParams({
        title: query.title,
        "language.code": "en",
        per_page: "10",
        "source.rank.opr.min": "0.3", // minimum source quality
      });
      const url = `https://api.apitube.io/v1/news/everything?${params.toString()}`;

      const data = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          timeout: 15000,
          headers: { "X-API-Key": APITUBE_API_KEY },
        }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error("Invalid JSON response"));
            }
          });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
      });

      if (data.results && Array.isArray(data.results)) {
        let accepted = 0, rejected = 0, blocked = 0;
        for (const item of data.results) {
          const title = item.title || "";
          const description = item.description || "";
          const content = item.content || item.description || "";
          const articleUrl = item.href || item.link || "";

          // ── BLOCK known junk domains ──
          if (isDomainBlocked(articleUrl)) {
            blocked++;
            continue;
          }

          // ── RELEVANCE GATE ──
          const trusted = isDomainTrusted(articleUrl);
          const threshold = trusted ? 2 : 3;
          const text = `${title} ${description} ${content}`.toLowerCase();
          let matchCount = 0;
          for (const kw of INSURANCE_KEYWORDS) {
            if (text.includes(kw)) matchCount++;
            if (matchCount >= threshold) break;
          }
          if (matchCount < threshold) {
            rejected++;
            continue;
          }

          const { tag, tagColor } = assignTag(title, description, "Insurance");
          const cleanContent = cleanSummary(content) || cleanSummary(description);

          results.push({
            id: `at_${Buffer.from(title).toString("base64").slice(0, 16)}`,
            title: title,
            dek: truncate(cleanSummary(description), 160),
            fullContent: cleanContent,
            link: articleUrl,
            pubDate: item.published_at || new Date().toISOString(),
            time: timeAgo(item.published_at || new Date()),
            source: "InsuralIQ",
            tag,
            tagColor,
            india: true,
            trusted,
            concepts: detectConcepts(`${title} ${cleanContent}`),
          });
          accepted++;
        }
        console.log(`  ✅ APITube "${query.label}": ${accepted} accepted, ${rejected} irrelevant, ${blocked} blocked`);
      } else {
        const errMsg = data.error || data.message || "No results";
        console.log(`  ⚠ APITube "${query.label}": ${errMsg}`);
      }
    } catch (err) {
      console.log(`  ⚠ APITube "${query.label}": ${err.message}`);
    }
  }
  return results;
}

// ── RSS Feed Fetch ─────────────────────────────────────────────
async function fetchFromRSSFeeds() {
  const results = [];
  const errors = [];

  await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        const items = (parsed.items || []).slice(0, 15);
        for (const item of items) {
          const title = item.title || "Untitled";
          const snippet = item.contentSnippet || item.content || "";
          const fullContent = extractFullContent(item);

          // ── RELEVANCE GATE: reject non-insurance articles ──
          if (!isInsuranceRelevant(title, snippet, fullContent)) continue;

          const { tag, tagColor } = assignTag(title, snippet, feed.defaultTag);
          results.push({
            id: Buffer.from(item.link || title).toString("base64").slice(0, 20),
            title: title,
            dek: truncate(snippet),
            fullContent: fullContent || truncate(snippet, 800),
            link: item.link || "",
            pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
            time: timeAgo(item.pubDate || item.isoDate || new Date()),
            source: "InsuralIQ",
            tag,
            tagColor,
            india: feed.india,
            concepts: detectConcepts(`${title} ${fullContent || snippet}`),
          });
        }
      } catch (err) {
        errors.push({ source: feed.source, url: feed.url, error: err.message });
      }
    })
  );

  return { results, errors };
}

// ── Accumulated articles from previous rotations ──────────────
// Since we only fetch 2 queries per cycle, we keep articles from
// earlier rotations and merge new ones in. This builds a rich pool
// throughout the day. Articles older than 48h are auto-pruned.
let accumulatedArticles = [];

// ── Main Fetch (API first → RSS fallback → Seed fallback) ─────
async function fetchAllFeeds() {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] Fetching news...`);

  let newResults = [];
  let errors = [];

  // Step 1: Try NewsData.io API (rotated queries)
  if (NEWSDATA_API_KEY) {
    console.log("  📡 [1/3] NewsData.io API...");
    const apiResults = await fetchFromNewsDataAPI();
    if (apiResults.length > 0) {
      newResults = [...newResults, ...apiResults];
      newsSource = "api";
      console.log(`  ✅ Got ${apiResults.length} articles from NewsData.io`);
    }
  }

  // Step 2: Try APITube.io API (rotated queries)
  if (APITUBE_API_KEY) {
    console.log("  📡 [2/3] APITube.io API...");
    const apitubeResults = await fetchFromAPITube();
    if (apitubeResults.length > 0) {
      newResults = [...newResults, ...apitubeResults];
      if (newsSource !== "api") newsSource = "apitube";
      console.log(`  ✅ Got ${apitubeResults.length} articles from APITube`);
    }
  }

  // Step 3: Also try RSS feeds (bonus articles if they work)
  console.log("  📡 [3/3] RSS feeds...");
  const { results: rssResults, errors: rssErrors } = await fetchFromRSSFeeds();
  errors = rssErrors;

  if (rssResults.length > 0) {
    newResults = [...newResults, ...rssResults];
    if (!newsSource || newsSource === "none") newsSource = "rss";
    console.log(`  ✅ Got ${rssResults.length} articles from RSS`);
  }

  if (rssErrors.length > 0) {
    console.log(`  ⚠ ${rssErrors.length} RSS feeds failed`);
    rssErrors.forEach((e) => console.log(`    → ${e.source}: ${e.error}`));
  }

  // Merge new articles into the accumulated pool
  accumulatedArticles = [...newResults, ...accumulatedArticles];

  // Prune articles older than 48 hours from the pool
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
  accumulatedArticles = accumulatedArticles.filter(
    (a) => new Date(a.pubDate) >= cutoff48h
  );

  // Sort by date, newest first
  accumulatedArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Deduplicate by title similarity
  const seen = new Set();
  const deduped = accumulatedArticles.filter((item) => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  accumulatedArticles = deduped; // keep the deduped version

  // Auto-expire curated articles older than 48 hours
  const now = new Date();
  const activeCurated = curatedArticles.filter((a) => {
    const age = now - new Date(a.pubDate);
    return age < 48 * 60 * 60 * 1000; // 48 hours in ms
  });
  if (activeCurated.length < curatedArticles.length) {
    const expired = curatedArticles.length - activeCurated.length;
    console.log(`  🕐 Auto-expired ${expired} curated article(s) (older than 48h)`);
    curatedArticles = activeCurated;
  }

  // Merge curated articles (on top, never filtered out)
  newsCache = [...curatedArticles, ...deduped];
  lastFetchTime = new Date().toISOString();
  fetchErrors = errors;

  // Step 3: If nothing worked, use seed data
  if (deduped.length === 0) {
    newsCache = [...curatedArticles, ...SEED_ARTICLES];
    usingSeed = true;
    newsSource = "seed";
    console.log(`  📦 No live news — using ${SEED_ARTICLES.length} seed articles`);
  } else {
    usingSeed = false;
    const today = new Date().toDateString();
    const todayCount = deduped.filter(a => new Date(a.pubDate).toDateString() === today).length;
    console.log(`  📊 Total: ${deduped.length} articles (${todayCount} from today) | Curated: ${curatedArticles.length} active`);
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
//   ?fresh=true         — only today's + yesterday's articles (default: true)
//   ?days=1             — articles from last N days (default: 2)
app.get("/api/news", (req, res) => {
  let items = [...newsCache];

  // Fresh filter: show only recent articles by default
  const freshMode = req.query.fresh !== "false"; // default true
  const daysBack = parseInt(req.query.days) || 2; // default: today + yesterday

  if (freshMode && !usingSeed) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    cutoff.setHours(0, 0, 0, 0);
    const freshItems = items.filter((i) => new Date(i.pubDate) >= cutoff);

    // If we have fresh articles, use them; otherwise show most recent 15
    if (freshItems.length > 0) {
      items = freshItems;
    } else {
      items = items.slice(0, 15); // show most recent even if older
    }
  }

  // Tag filter
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

  // Recalculate "time" to keep it fresh on each request
  items = items.map((i) => ({ ...i, time: timeAgo(i.pubDate) }));

  res.json({
    ok: true,
    total,
    limit,
    offset,
    lastFetched: lastFetchTime,
    source: newsSource,
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
  const today = new Date().toDateString();
  const todayCount = newsCache.filter(a => new Date(a.pubDate).toDateString() === today).length;
  res.json({
    ok: true,
    articleCount: newsCache.length,
    todayCount,
    curatedCount: curatedArticles.length,
    lastFetched: lastFetchTime,
    newsSource,
    apis: {
      newsdata: { configured: !!NEWSDATA_API_KEY, rotation: `${queryRotationIndex}/${NEWSDATA_QUERIES.length}`, perCycle: QUERIES_PER_CYCLE },
      apitube: { configured: !!APITUBE_API_KEY, rotation: `${apitubeRotationIndex}/${APITUBE_QUERIES.length}`, perCycle: APITUBE_QUERIES_PER_CYCLE },
    },
    qualityControl: {
      trustedDomains: TRUSTED_DOMAINS.size,
      blockedDomains: BLOCKED_DOMAINS.size,
      insuranceKeywords: INSURANCE_KEYWORDS.length,
      trustedThreshold: 2,
      unknownThreshold: 3,
    },
    refreshInterval: "15 min",
    feedCount: FEEDS.length,
    feedErrors: fetchErrors.length,
    usingSeedData: usingSeed,
    errors: fetchErrors,
  });
});

// ── Admin API: Curated Articles ───────────────────────────────
app.use(express.json());

// POST /api/admin/article — add a curated article
app.post("/api/admin/article", (req, res) => {
  const { key, title, summary, tag, link } = req.body;
  if (key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "Invalid admin key" });
  if (!title || !summary) return res.status(400).json({ ok: false, error: "Title and summary are required" });

  const { tag: autoTag, tagColor } = assignTag(title, summary, tag || "Insurance");
  const finalTag = tag || autoTag;
  const finalColor = TAG_RULES.find(r => r.tag === finalTag)?.color || tagColor;

  const article = {
    id: `curated_${Date.now()}`,
    title: title.trim(),
    dek: truncate(summary, 160),
    fullContent: summary.trim(),
    link: link || "#",
    pubDate: new Date().toISOString(),
    time: "Just now",
    source: "InsuralIQ",
    tag: finalTag,
    tagColor: finalColor,
    india: true,
    curated: true,
    concepts: detectConcepts(`${title} ${summary}`),
  };

  curatedArticles.unshift(article); // Add to top
  newsCache = [article, ...newsCache]; // Immediately visible
  console.log(`  📝 Curated article added: "${title.slice(0, 50)}..."`);
  res.json({ ok: true, article });
});

// DELETE /api/admin/article/:id — remove a curated article
app.delete("/api/admin/article/:id", (req, res) => {
  const { key } = req.body || {};
  if (key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "Invalid admin key" });
  curatedArticles = curatedArticles.filter(a => a.id !== req.params.id);
  newsCache = newsCache.filter(a => a.id !== req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/curated — list curated articles
app.get("/api/admin/curated", (req, res) => {
  res.json({ ok: true, articles: curatedArticles });
});

// GET /admin — admin panel page
app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>InsuralIQ Admin — Add News</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #f5f5f0; color: #1A2B32; min-height: 100vh; }
  .container { max-width: 600px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; color: #0E7C86; }
  .subtitle { font-size: 13px; color: #5B6B70; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  label { display: block; font-size: 13px; font-weight: 600; color: #1A2B32; margin-bottom: 6px; }
  input, textarea, select { width: 100%; padding: 10px 12px; border: 1.5px solid #ECE9E2; border-radius: 8px; font: 400 14px 'Inter', sans-serif; color: #1A2B32; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #0E7C86; }
  textarea { resize: vertical; min-height: 140px; line-height: 1.6; }
  .field { margin-bottom: 16px; }
  .btn { display: inline-block; padding: 12px 28px; background: #0E7C86; color: #fff; border: none; border-radius: 8px; font: 600 14px 'Inter', sans-serif; cursor: pointer; }
  .btn:hover { background: #0A5A62; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger { background: #D35400; }
  .btn-danger:hover { background: #a04000; }
  .msg { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; display: none; }
  .msg.success { display: block; background: #E4F1F1; color: #0E7C86; }
  .msg.error { display: block; background: #FFEDE9; color: #D35400; }
  .existing { font-size: 13px; color: #5B6B70; }
  .existing-item { padding: 10px 0; border-bottom: 1px solid #ECE9E2; display: flex; justify-content: space-between; align-items: start; gap: 10px; }
  .existing-item:last-child { border-bottom: none; }
  .existing-title { font-weight: 500; color: #1A2B32; font-size: 13px; }
  .existing-meta { font-size: 11px; color: #5B6B70; margin-top: 2px; }
  .del-btn { background: none; border: 1px solid #D35400; color: #D35400; padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; white-space: nowrap; }
  .tips { font-size: 12px; color: #5B6B70; line-height: 1.7; }
  .tips strong { color: #1A2B32; }
</style>
</head>
<body>
<div class="container">
  <h1>InsuralIQ Editor Panel</h1>
  <p class="subtitle">Add curated insurance news · Articles auto-expire after 48 hours</p>

  <div id="msg" class="msg"></div>

  <div class="card">
    <div class="field">
      <label>Admin Key</label>
      <input type="password" id="key" placeholder="Enter your admin key" />
    </div>
    <div class="field">
      <label>Headline</label>
      <input type="text" id="title" placeholder="e.g. BNP Paribas Cardif acquires 26% stake in IndiaFirst Life" />
    </div>
    <div class="field">
      <label>Full Summary</label>
      <textarea id="summary" placeholder="Write a comprehensive 3-4 paragraph summary of the news. This is what users will read on InsuralIQ."></textarea>
    </div>
    <div class="field">
      <label>Category</label>
      <select id="tag">
        <option value="">Auto-detect</option>
        <option value="IRDAI">IRDAI / Regulation</option>
        <option value="Life Insurance">Life Insurance</option>
        <option value="Health">Health Insurance</option>
        <option value="Motor">Motor Insurance</option>
        <option value="InsurTech">InsurTech</option>
        <option value="Global">Global / Reinsurance</option>
        <option value="Market">Market / IPO / FDI</option>
        <option value="Claims">Claims</option>
      </select>
    </div>
    <div class="field">
      <label>Source Link (optional)</label>
      <input type="url" id="link" placeholder="https://... (original article URL, if any)" />
    </div>
    <button class="btn" id="submitBtn" onclick="submitArticle()">Publish Article</button>
  </div>

  <div class="card">
    <label>Your Curated Articles</label>
    <div id="curatedList" class="existing" style="margin-top:10px">Loading...</div>
  </div>

  <div class="card tips">
    <label>Tips for Great Summaries</label>
    <p><strong>Paragraph 1:</strong> What happened? The key news in 2-3 sentences.</p>
    <p><strong>Paragraph 2:</strong> Background — why does this matter for the insurance industry?</p>
    <p><strong>Paragraph 3:</strong> Impact — what does this mean for policyholders, companies, or students?</p>
    <p><strong>Paragraph 4 (optional):</strong> Your analysis or key takeaway.</p>
    <p style="margin-top:8px">Separate paragraphs with a blank line for best readability.</p>
  </div>
</div>

<script>
const API = window.location.origin;

async function submitArticle() {
  const key = document.getElementById('key').value;
  const title = document.getElementById('title').value;
  const summary = document.getElementById('summary').value;
  const tag = document.getElementById('tag').value;
  const link = document.getElementById('link').value;
  const msg = document.getElementById('msg');

  if (!key || !title || !summary) {
    msg.className = 'msg error';
    msg.textContent = 'Please fill in Admin Key, Headline, and Summary.';
    return;
  }

  document.getElementById('submitBtn').disabled = true;
  try {
    const res = await fetch(API + '/api/admin/article', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, title, summary, tag, link }),
    });
    const data = await res.json();
    if (data.ok) {
      msg.className = 'msg success';
      msg.textContent = 'Article published! It\\'s now live on InsuralIQ.';
      document.getElementById('title').value = '';
      document.getElementById('summary').value = '';
      document.getElementById('link').value = '';
      loadCurated();
    } else {
      msg.className = 'msg error';
      msg.textContent = data.error || 'Failed to publish.';
    }
  } catch(e) {
    msg.className = 'msg error';
    msg.textContent = 'Network error. Try again.';
  }
  document.getElementById('submitBtn').disabled = false;
}

async function loadCurated() {
  try {
    const res = await fetch(API + '/api/admin/curated');
    const data = await res.json();
    const list = document.getElementById('curatedList');
    if (!data.articles || data.articles.length === 0) {
      list.innerHTML = '<p>No curated articles yet. Add your first one above!</p>';
      return;
    }
    list.innerHTML = data.articles.map(a => {
      const ageH = Math.round((Date.now() - new Date(a.pubDate).getTime()) / 3600000);
      const remaining = Math.max(0, 48 - ageH);
      const expiryText = remaining > 0 ? \`Expires in \${remaining}h\` : 'Expiring soon';
      return \`
      <div class="existing-item">
        <div>
          <div class="existing-title">\${a.title}</div>
          <div class="existing-meta">\${a.tag} · \${new Date(a.pubDate).toLocaleDateString()} · ⏱ \${expiryText}</div>
        </div>
        <button class="del-btn" onclick="deleteArticle('\${a.id}')">Remove</button>
      </div>
    \`}).join('');
  } catch(e) {
    document.getElementById('curatedList').innerHTML = '<p>Failed to load.</p>';
  }
}

async function deleteArticle(id) {
  const key = document.getElementById('key').value;
  if (!key) { alert('Enter admin key first'); return; }
  if (!confirm('Remove this article?')) return;
  try {
    await fetch(API + '/api/admin/article/' + id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    loadCurated();
  } catch(e) { alert('Failed to delete'); }
}

loadCurated();
</script>
</body>
</html>`);
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
  console.log(`  └──────────────────────────────────────┘`);
  console.log(`  📡 NewsData.io: ${NEWSDATA_API_KEY ? "✅ Key set" : "❌ No key"} | ${QUERIES_PER_CYCLE} queries/cycle × ${NEWSDATA_QUERIES.length} total`);
  console.log(`  📡 APITube.io:  ${APITUBE_API_KEY ? "✅ Key set" : "❌ No key"} | ${APITUBE_QUERIES_PER_CYCLE} queries/cycle × ${APITUBE_QUERIES.length} total`);
  console.log(`  🔒 Quality: ${TRUSTED_DOMAINS.size} trusted domains | ${BLOCKED_DOMAINS.size} blocked | ${INSURANCE_KEYWORDS.length} keywords`);
  console.log(`  ⏱  Refresh: every 15 min\n`);

  // Initial fetch on startup
  await fetchAllFeeds();

  // Refresh every 15 minutes — dual API rotation
  cron.schedule("*/15 * * * *", fetchAllFeeds);
});
