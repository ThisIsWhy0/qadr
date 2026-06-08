// Qadr — Predict anything. Earn on everything. Real stakes, zero risk.
// Main API server — with Polymarket data feed
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const Database = require("better-sqlite3");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, "..", "qadr.db");
const JWT_SECRET = process.env.JWT_SECRET || "qadr-scoped-" + uuid();
const SALT_ROUNDS = 10;
const POLY_API = "https://gamma-api.polymarket.com";

// ── Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function db() {
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  return d;
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
}

function awardCoins(d, userId, amount, type, desc, refId) {
  d.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(amount, userId);
  const bal = d.prepare("SELECT coins FROM users WHERE id = ?").get(userId).coins;
  d.prepare("INSERT INTO coin_transactions (id,user_id,amount,type,description,reference_id,balance_after) VALUES (?,?,?,?,?,?,?)")
    .run(uuid(), userId, amount, type, desc, refId || null, bal);
  return bal;
}

// ── Polymarket API proxy
function fetchPoly(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

// Get transformed Polymarket data — includes multi-outcome markets
async function getPolyMarkets(query = {}) {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    limit: query.limit || "80",
    order: query.order || "volume24hr",
    ascending: "false",
  });
  if (query.q) params.set("q", query.q);

  const raw = await fetchPoly(`${POLY_API}/markets?${params}`);

  // Group markets by event slug
  const eventMap = {};
  const standalone = [];

  for (const m of raw) {
    const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : (m.outcomes || ["Yes","No"]);
    const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : (m.outcomePrices || ["0.5","0.5"]);
    const events = m.events || [];

    if (outcomes.length > 2) {
      // True multi-outcome market — show directly
      standalone.push(transformMarket(m, outcomes, prices));
    } else if (events.length > 0) {
      // Binary market belonging to an event — group it
      const slug = events[0].slug || "unknown";
      if (!eventMap[slug]) {
        eventMap[slug] = {
          id: "event-" + slug,
          question: events[0].title || m.question,
          description: events[0].description || "",
          category: slug.split("-")[0] || "general",
          image: events[0].image || m.image || "",
          slug: slug,
          markets: [],
          volume24hr: 0,
          volume: 0,
        };
      }
      eventMap[slug].markets.push({
        id: m.id,
        question: m.question,
        outcomes,
        prices,
        volume24hr: parseFloat(m.volume24hr || 0),
      });
      eventMap[slug].volume24hr += parseFloat(m.volume24hr || 0);
      eventMap[slug].volume += parseFloat(m.volume || 0);
    } else {
      standalone.push(transformMarket(m, outcomes, prices));
    }
  }

  // Convert event groups to multi-outcome cards
  const grouped = Object.values(eventMap).map(evt => {
    // Collect unique candidate names from market questions
    const candidateSet = {};
    for (const m of evt.markets) {
      // Extract candidate name from "Will X win...?" pattern
      const match = m.question.match(/Will (.+?) win/i) || m.question.match(/^(.*?) vs\./i);
      const name = match ? match[1].trim() : m.question;
      if (!candidateSet[name]) {
        candidateSet[name] = { name, price: parseFloat(m.prices[0]) || 0, volume: m.volume24hr };
      }
    }

    const outcomes = Object.keys(candidateSet);
    const prices = outcomes.map(o => String(candidateSet[o].price));

    // Sort by price descending
    const sorted = outcomes.map((o, i) => ({ name: o, price: parseFloat(prices[i]) }))
      .sort((a, b) => b.price - a.price);

    return {
      id: evt.id,
      question: evt.question,
      description: evt.description,
      category: evt.category,
      image: evt.image,
      outcomes: sorted.map(s => s.name),
      prices: sorted.map(s => String(s.price)),
      volume24hr: evt.volume24hr,
      volume: evt.volume,
      isGrouped: true,
      groupSize: evt.markets.length,
    };
  });

  // Combine: multi-outcome grouped + standalone binary
  return [...grouped, ...standalone];
}

function transformMarket(m, outcomes, prices) {
  return {
    id: m.id,
    question: m.question,
    description: m.description || "",
    category: (m.events?.[0]?.slug || "general").split("-")[0] || "general",
    outcomes,
    prices,
    volume: parseFloat(m.volume || 0),
    volume24hr: parseFloat(m.volume24hr || 0),
    liquidity: parseFloat(m.liquidity || 0),
    endDate: m.endDateIso || m.endDate || "",
    slug: m.slug || "",
    image: m.image || "",
    oneDayChange: m.oneDayPriceChange || 0,
    oneWeekChange: m.oneWeekPriceChange || 0,
    oneMonthChange: m.oneMonthPriceChange || 0,
    isGrouped: false,
  };
}

// ── AUTH
app.post("/api/auth/signup", (req, res) => {
  const { username, email, password, displayName, referralCode } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });
  const d = db();
  try {
    if (d.prepare("SELECT id FROM users WHERE username=? OR email=?").get(username, email))
      return res.status(409).json({ error: "Username or email taken" });
    const id = uuid(), hash = bcrypt.hashSync(password, SALT_ROUNDS), ref = uuid().slice(0, 8);
    let refBy = null, startCoins = 500;
    if (referralCode) {
      const r = d.prepare("SELECT id FROM users WHERE referral_code=?").get(referralCode);
      if (r) { refBy = r.id; startCoins += 200; }
    }
    d.prepare("INSERT INTO users (id,username,email,password_hash,display_name,coins,referral_code,referred_by) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, username, email, hash, displayName||username, startCoins, ref, refBy);
    awardCoins(d, id, 500, "signup_bonus", "Welcome to Qadr! 500 coins on the house.");
    if (refBy) {
      awardCoins(d, refBy, 100, "referral", `${username} joined via your code!`, id);
      d.prepare("INSERT INTO referrals (id,referrer_id,referred_id) VALUES (?,?,?)").run(uuid(), refBy, id);
    }
    const token = jwt.sign({ userId: id, username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id, username, displayName: displayName||username, coins: startCoins } });
  } finally { d.close(); }
});

app.post("/api/auth/signin", (req, res) => {
  const { username, password } = req.body;
  const d = db();
  try {
    const u = d.prepare("SELECT * FROM users WHERE username=? OR email=?").get(username, username);
    if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ userId: u.id, username: u.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id:u.id, username:u.username, displayName:u.display_name, email:u.email, coins:u.coins, referralCode:u.referral_code, totalPredictions:u.total_predictions, correctPredictions:u.correct_predictions, currentStreak:u.current_streak } });
  } finally { d.close(); }
});

// ── DAILY LOGIN
app.post("/api/daily-login", auth, (req, res) => {
  const d = db();
  try {
    const today = new Date().toISOString().split("T")[0];
    if (d.prepare("SELECT 1 FROM daily_logins WHERE user_id=? AND login_date=?").get(req.user.userId, today))
      return res.json({ awarded: 0, message: "Already claimed today!" });
    d.prepare("INSERT INTO daily_logins (user_id,login_date,coins_awarded) VALUES (?,?,10)").run(req.user.userId, today);
    const yesterday = new Date(Date.now()-86400000).toISOString().split("T")[0];
    if (d.prepare("SELECT 1 FROM daily_logins WHERE user_id=? AND login_date=?").get(req.user.userId, yesterday)) {
      d.prepare("UPDATE users SET current_streak=current_streak+1 WHERE id=?").run(req.user.userId);
      const streak = d.prepare("SELECT current_streak FROM users WHERE id=?").get(req.user.userId).current_streak;
      if (streak === 7) awardCoins(d, req.user.userId, 50, "streak", "7-day streak bonus!");
      else if (streak === 30) awardCoins(d, req.user.userId, 200, "streak", "30-day streak bonus!");
      if (streak > d.prepare("SELECT longest_streak FROM users WHERE id=?").get(req.user.userId).longest_streak)
        d.prepare("UPDATE users SET longest_streak=? WHERE id=?").run(streak, req.user.userId);
    } else {
      d.prepare("UPDATE users SET current_streak=1 WHERE id=?").run(req.user.userId);
    }
    const coins = awardCoins(d, req.user.userId, 10, "login", "Daily login bonus");
    res.json({ awarded: 10, coins, message: "+10 coins!" });
  } finally { d.close(); }
});

// ── MARKETS — fetches from Polymarket API
app.get("/api/markets", async (req, res) => {
  try {
    console.log("[QADR] Fetching Polymarket data...");
    const markets = await getPolyMarkets({
      limit: req.query.limit || 50,
      q: req.query.q || "",
      order: req.query.order || "volume24hr",
    });
    console.log(`[QADR] Got ${markets.length} markets from Polymarket`);
    res.json(markets);
  } catch (e) {
    console.error("[QADR] Error fetching Polymarket:", e.message);
    res.status(500).json({ error: "Failed to fetch markets", detail: e.message });
  }
});

app.get("/api/markets/:id", async (req, res) => {
  try {
    // Handle grouped event IDs (event-{slug})
    if (req.params.id.startsWith("event-")) {
      const slug = req.params.id.replace("event-", "");
      const events = await fetchPoly(`${POLY_API}/events?slug=${slug}&active=true&closed=false`);
      if (!events || events.length === 0) return res.status(404).json({ error: "Event not found" });
      const evt = events[0];
      const markets = evt.markets || [];
      const candidateSet = {};
      for (const m of markets) {
        const match = m.question.match(/Will (.+?) win/i) || m.question.match(/^(.*?) vs\./i);
        const name = match ? match[1].trim() : m.question;
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : (m.outcomePrices || ["0"]);
        if (!candidateSet[name]) candidateSet[name] = { name, price: parseFloat(prices[0]) || 0 };
      }
      const sorted = Object.values(candidateSet).sort((a, b) => b.price - a.price);
      return res.json({
        id: req.params.id,
        question: evt.title,
        description: evt.description || "",
        category: slug.split("-")[0] || "general",
        image: evt.image || "",
        outcomes: sorted.map(s => s.name),
        prices: sorted.map(s => String(s.price)),
        volume24hr: parseFloat(evt.volume24hr || 0),
        volume: parseFloat(evt.volume || 0),
        isGrouped: true,
        groupSize: markets.length,
      });
    }

    const m = await fetchPoly(`${POLY_API}/markets/${req.params.id}`);
    if (!m) return res.status(404).json({ error: "Not found" });
    const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : (m.outcomes || ["Yes","No"]);
    const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : (m.outcomePrices || ["0.5","0.5"]);
    const market = transformMarket(m, outcomes, prices);

    try {
      const d2 = db();
      try {
        d2.prepare("INSERT OR IGNORE INTO markets (id,question,description,category,resolution_type,status,closes_at) VALUES (CAST(? AS TEXT),?,?,?,'binary','active',?)")
          .run(String(m.id), m.question, m.description||"", market.category, market.endDate||null);
      } finally { d2.close(); }
    } catch (dbErr) { console.error("[QADR] DB upsert:", dbErr.message); }

    res.json(market);
  } catch (e) { res.status(500).json({ error: "Failed to fetch market", detail: e.message }); }
});

// Get price history for a market (from Polymarket events/CLOB)
app.get("/api/markets/:id/history", async (req, res) => {
  try {
    // Try CLOB API for price history
    const history = await fetchPoly(`${POLY_API}/markets/${req.params.id}/history?limit=100`);
    res.json(history);
  } catch (e) {
    // Return empty if unavailable
    res.json([]);
  }
});

// ── User creates their own market (costs coins)
app.post("/api/markets", auth, (req, res) => {
  const { question, description, category } = req.body;
  if (!question) return res.status(400).json({ error: "Question required" });
  const d = db();
  try {
    const u = d.prepare("SELECT coins FROM users WHERE id=?").get(req.user.userId);
    if (u.coins < 500) return res.status(400).json({ error: "Need 500 coins" });
    const id = "qadr-" + uuid();
    d.prepare("INSERT INTO markets (id,question,description,category,resolution_type,creator_id,status) VALUES (?,?,?,?,?,'active')")
      .run(id, question, description||"", category||"custom", req.user.userId, "binary");
    awardCoins(d, req.user.userId, -500, "market_create", `Created: "${question.slice(0,50)}"`, id);
    res.json({ id, coins: u.coins - 500 });
  } finally { d.close(); }
});

// ── PREDICTIONS — users stake Qadr coins on Polymarket markets
app.post("/api/predict", auth, (req, res) => {
  const { marketId, outcome, coins } = req.body;
  if (!marketId || !outcome || !coins) return res.status(400).json({ error: "Missing fields" });
  if (coins < 10) return res.status(400).json({ error: "Min 10 coins" });

  const d = db();
  try {
    const market = d.prepare("SELECT * FROM markets WHERE id=?").get(marketId);
    if (!market) return res.status(400).json({ error: "Market not found" });

    const u = d.prepare("SELECT coins FROM users WHERE id=?").get(req.user.userId);
    if (u.coins < coins) return res.status(400).json({ error: `Need ${coins} coins, have ${u.coins}` });

    const id = uuid();
    d.prepare("INSERT INTO predictions (id,user_id,market_id,outcome,coins_at_stake,odds_at_time) VALUES (?,?,?,?,?,?)")
      .run(id, req.user.userId, marketId, outcome, coins, parseFloat(outcome === "1" ? 0.5 : 0.5));
    awardCoins(d, req.user.userId, -coins, "prediction", `Predicted on "${market.question.slice(0,40)}"`, id);
    res.json({ id, coins: u.coins - coins });
  } finally { d.close(); }
});

// ── LEADERBOARD
app.get("/api/leaderboard", (req, res) => {
  const d = db();
  try {
    const leaders = d.prepare(`
      SELECT u.id, u.username, u.display_name, u.current_streak, u.longest_streak,
             u.total_predictions, u.correct_predictions, u.coins,
             RANK() OVER (ORDER BY u.correct_predictions DESC) as rank
      FROM users u ORDER BY u.correct_predictions DESC LIMIT 100
    `).all();
    res.json(leaders);
  } finally { d.close(); }
});

// ── PRIZES
app.get("/api/prizes", (req, res) => {
  res.json([
    { id:"amazon5", type:"amazon", label:"$5 Amazon Gift Card", coinsCost:5000, icon:"🛒" },
    { id:"amazon10", type:"amazon", label:"$10 Amazon Gift Card", coinsCost:9000, icon:"🛒" },
    { id:"starbucks5", type:"starbucks", label:"$5 Starbucks", coinsCost:4000, icon:"☕" },
    { id:"starbucks10", type:"starbucks", label:"$10 Starbucks", coinsCost:7500, icon:"☕" },
    { id:"visa25", type:"visa", label:"$25 Visa Prepaid", coinsCost:20000, icon:"💳" },
    { id:"premium1", type:"premium", label:"1 Month Premium", coinsCost:1000, icon:"⭐" },
  ]);
});

app.post("/api/redeem", auth, (req, res) => {
  const prizes = { amazon5:{label:"$5 Amazon",cost:5000}, amazon10:{label:"$10 Amazon",cost:9000}, starbucks5:{label:"$5 Starbucks",cost:4000}, starbucks10:{label:"$10 Starbucks",cost:7500}, visa25:{label:"$25 Visa",cost:20000}, premium1:{label:"1M Premium",cost:1000} };
  const p = prizes[req.body.prizeId];
  if (!p) return res.status(400).json({ error: "Invalid" });
  const d = db();
  try {
    const u = d.prepare("SELECT coins FROM users WHERE id=?").get(req.user.userId);
    if (u.coins < p.cost) return res.status(400).json({ error: `Need ${p.cost} coins` });
    const id = uuid();
    d.prepare("INSERT INTO redemptions (id,user_id,prize_type,prize_label,coins_cost,status) VALUES (?,?,?,?,?,?)")
      .run(id, req.user.userId, req.body.prizeId, p.label, p.cost, "pending");
    awardCoins(d, req.user.userId, -p.cost, "prize_redeem", `Redeemed ${p.label}`, id);
    res.json({ id, coins: u.coins - p.cost });
  } finally { d.close(); }
});

// ── USER PROFILE
app.get("/api/me", auth, (req, res) => {
  const d = db();
  try {
    const u = d.prepare("SELECT id,username,display_name,email,coins,bio,total_predictions,correct_predictions,current_streak,longest_streak,is_premium,referral_code,created_at FROM users WHERE id=?").get(req.user.userId);
    u.recentTransactions = d.prepare("SELECT * FROM coin_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.user.userId);
    u.recentPredictions = d.prepare("SELECT p.*,m.question FROM predictions p JOIN markets m ON p.market_id=m.id WHERE p.user_id=? ORDER BY p.placed_at DESC LIMIT 20").all(req.user.userId);
    u.rank = d.prepare("SELECT COUNT(*)+1 as rank FROM users WHERE correct_predictions > (SELECT correct_predictions FROM users WHERE id=?)").get(req.user.userId).rank;
    res.json(u);
  } finally { d.close(); }
});

// ── AD VIEW
app.post("/api/earn/ad-view", auth, (req, res) => {
  const d = db();
  try {
    const recent = d.prepare("SELECT 1 FROM coin_transactions WHERE user_id=? AND type='ad_view' AND created_at > datetime('now','-5 minutes')" ).get(req.user.userId);
    if (recent) return res.status(429).json({ error: "Wait 5 minutes" });
    const coins = awardCoins(d, req.user.userId, 15, "ad_view", "Watched sponsored content");
    res.json({ awarded: 15, coins });
  } finally { d.close(); }
});

// ── CATEGORIES (from Polymarket)
app.get("/api/categories", (req, res) => {
  res.json([
    { id: "", label: "All", icon: "🔥" },
    { id: "politics", label: "Politics", icon: "🏛️" },
    { id: "sports", label: "Sports", icon: "⚽" },
    { id: "crypto", label: "Crypto", icon: "₿" },
    { id: "tech", label: "Tech", icon: "💻" },
    { id: "science", label: "Science", icon: "🔬" },
    { id: "entertainment", label: "Culture", icon: "🎬" },
    { id: "economy", label: "Economy", icon: "📈" },
    { id: "geopolitics", label: "Geopolitics", icon: "🌍" },
    { id: "weather", label: "Weather", icon: "🌤️" },
  ]);
});

// ── FALLBACK
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(PORT, "0.0.0.0", () => console.log(`Qadr running on port ${PORT}`));
