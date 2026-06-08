// Qadr — Predict anything. Earn on everything. Real stakes, zero risk.
// Main API server — caches Polymarket data locally, serves from our own DB
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

// ── DB helper
function db() {
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  return d;
}

// ── Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
}

// ── Coin helper
function awardCoins(d, userId, amount, type, desc, refId) {
  d.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(amount, userId);
  const bal = d.prepare("SELECT coins FROM users WHERE id = ?").get(userId).coins;
  d.prepare("INSERT INTO coin_transactions (id,user_id,amount,type,description,reference_id,balance_after) VALUES (?,?,?,?,?,?,?)")
    .run(uuid(), userId, amount, type, desc, refId || null, bal);
  return bal;
}

// ── Polymarket API (with timeout)
function fetchPoly(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── Sync markets from Polymarket → our DB
async function syncMarketsFromPolymarket() {
  console.log("[QADR] Starting market sync...");
  const d = db();
  const startTime = Date.now();

  try {
    // ── PASS 1: Multi-outcome events ──
    const events = await fetchPoly(`${POLY_API}/events?active=true&closed=false&limit=100&order=volume24hr&ascending=false`);
    console.log(`[QADR] Got ${events.length} events (${Date.now()-startTime}ms)`);

    let synced = 0;

    for (const evt of events) {
      const markets = evt.markets || [];
      if (markets.length === 0) continue;

      const firstMarket = markets[0];
      const firstOutcomes = typeof firstMarket.outcomes === "string" ? JSON.parse(firstMarket.outcomes) : (firstMarket.outcomes || ["Yes","No"]);
      const allBinary = markets.every(m => {
        const o = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : (m.outcomes || ["Yes","No"]);
        return o.length === 2;
      });

      if (allBinary && firstOutcomes.length === 2 && markets.length > 3) {
        // Check if all markets are the SAME yes/no question with different parameters
        // (e.g. "Iran closes its airspace by May 8?", "Iran closes its airspace by May 15?")
        // Pattern: same prefix, different date/number at the end
        const baseQuestions = markets.map(m => {
          const q = m.question;
          // Remove trailing date/number info
          return q.replace(/\b(by|on|before|after|until)\s+.*$/, '').trim().toLowerCase();
        });
        const uniqueBases = new Set(baseQuestions);

        if (uniqueBases.size <= 2) {
          // Repeated binary: same question, different dates/thresholds
          const sortedPrices = markets.map(m => {
            const p = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : (m.outcomePrices || ["0.5","0.5"]);
            return parseFloat(p[0]) || 0.5;
          }).sort((a, b) => a - b);
          const yesPrice = sortedPrices[Math.floor(sortedPrices.length / 2)] || 0.5;

          const category = detectCategory(evt.slug || "");
          const marketId = "evt-" + slugify(evt.slug || "");
          const now = new Date().toISOString();
          const vol24 = parseFloat(evt.volume24hr || 0);
          const vol = parseFloat(evt.volume || 0);
          upsertMarket(d, marketId, evt.title || "", evt.description || "", category, "binary", ["Yes", "No"], [yesPrice, 1 - yesPrice], vol, vol24, now);
          synced++;
          continue;
        }
      }

      // Multi-outcome: collect unique candidates
      const candidateSet = {};
      for (const m of markets) {
        const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : (m.outcomes || ["Yes","No"]);
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : (m.outcomePrices || ["0.5","0.5"]);

        if (outcomes.length === 2 && markets.length > 1) {
          const match = m.question.match(/Will (.+?) win/i) || m.question.match(/^(.*?) vs\./i) || m.question.match(/^Will (.+?)\?/i);
          const name = match ? match[1].trim() : m.question;
          const price = parseFloat(prices[0]) || 0;
          if (!candidateSet[name] || price > candidateSet[name].price) {
            candidateSet[name] = { name, price };
          }
        } else if (outcomes.length > 2) {
          for (let i = 0; i < outcomes.length; i++) {
            const name = outcomes[i];
            const price = parseFloat(prices[i]) || 0;
            if (!candidateSet[name]) candidateSet[name] = { name, price };
          }
        }
      }

      const candidates = Object.values(candidateSet);
      if (candidates.length >= 2) {
        candidates.sort((a, b) => b.price - a.price);
        const outcomes = candidates.map(c => c.name);
        const pricesArr = candidates.map(c => c.price);
        const category = detectCategory(evt.slug || "");
        const marketId = "evt-" + slugify(evt.slug || "");
        const now = new Date().toISOString();
        const vol24 = parseFloat(evt.volume24hr || 0);
        const vol = parseFloat(evt.volume || 0);
        upsertMarket(d, marketId, evt.title || "", evt.description || "", category, "multiple", outcomes, pricesArr, vol, vol24, now);
        synced++;
      }
    }

    // ── PASS 2: Individual binary markets from /markets endpoint ──
    // These are standalone binary markets NOT part of multi-outcome events
    console.log(`[QADR] Fetching individual markets (${Date.now()-startTime}ms)...`);
    let individualMarkets = [];
    try {
      individualMarkets = await fetchPoly(`${POLY_API}/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false`);
    } catch(e) {
      console.log(`[QADR] Individual markets fetch failed: ${e.message}`);
    }
    console.log(`[QADR] Got ${individualMarkets.length} individual markets (${Date.now()-startTime}ms)`);

    let binarySynced = 0;

    for (const m of individualMarkets) {
      const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : (m.outcomes || ["Yes","No"]);
      const pricesArr = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : (m.outcomePrices || ["0.5","0.5"]);

      if (outcomes.length !== 2) continue;

      const p0 = parseFloat(pricesArr[0]) || 0;
      if (p0 <= 0.001 || p0 >= 0.999) continue;

      // Skip markets that belong to events (already handled in Pass 1)
      const evts = m.events || [];
      if (evts.length > 0) continue;

      const mid = "mkt-" + String(m.id);

      const slug = m.slug || String(m.id);
      const category = detectCategory(slug);
      const now = new Date().toISOString();
      const vol24 = parseFloat(m.volume24hr || 0);
      const vol = parseFloat(m.volume || 0);

      upsertMarket(d, mid, m.question, m.description || "", category, "binary", outcomes, [p0, 1-p0], vol, vol24, now);
      binarySynced++;
    }

    console.log(`[QADR] Synced ${synced} multi + ${binarySynced} binary = ${synced+binarySynced} total (${Date.now()-startTime}ms)`);
  } catch (e) {
    console.error("[QADR] Sync error:", e.message);
  } finally {
    d.close();
  }
}

function detectCategory(slug) {
  if (!slug) return "general";
  if (slug.match(/election|president|political|senate|congress|governor|mayor/i)) return "politics";
  if (slug.match(/cup|sports|nba|nfl|soccer|football|tennis|baseball|hockey|ufc|f1|esports|mlb|nhl/i)) return "sports";
  if (slug.match(/bitcoin|crypto|ethereum|btc/i)) return "crypto";
  if (slug.match(/fed|interest|economy|gdp|inflation|recession|oil|crude|wti/i)) return "economy";
  if (slug.match(/iran|israel|geopolitics|war|peace|regime|strait|hormuz/i)) return "geopolitics";
  if (slug.match(/tech|ai|apple|google|microsoft|openai|spacex|tesla|elon|musk|ipo/i)) return "tech";
  if (slug.match(/science|climate|weather|space|nasa/i)) return "science";
  return "general";
}

function slugify(s) {
  return s.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function upsertMarket(d, marketId, question, description, category, resolutionType, outcomes, pricesArr, vol, vol24, now) {
  const existing = d.prepare("SELECT id FROM markets WHERE id = ?").get(marketId);
  if (existing) {
    d.prepare(`UPDATE markets SET question=?, description=?, category=?, resolution_type=?, outcomes=?, status=?, updated_at=? WHERE id=?`)
      .run(question, description, category, resolutionType, JSON.stringify(outcomes), "active", now, marketId);
  } else {
    d.prepare(`INSERT INTO markets (id,question,description,category,resolution_type,outcomes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(marketId, question, description, category, resolutionType, JSON.stringify(outcomes), "active", now, now);
  }

  // Upsert options and price history
  for (let i = 0; i < outcomes.length; i++) {
    const optId = marketId + "-opt-" + i;
    const price = pricesArr[i] || 0.5;
    const existingOpt = d.prepare("SELECT id FROM market_options WHERE id = ?").get(optId);
    if (existingOpt) {
      d.prepare("UPDATE market_options SET current_price=?, updated_at=? WHERE id=?").run(price, now, optId);
    } else {
      d.prepare("INSERT INTO market_options (id,market_id,outcome_name,current_price,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(optId, marketId, outcomes[i], price, now, now);
    }
    // Record price history (throttle: only keep last 100 per outcome)
    d.prepare("INSERT INTO price_history (id,market_id,outcome_index,price,recorded_at) VALUES (?,?,?,?,?)")
      .run(uuid(), marketId, i, price, now);
  }

  // Volume in points ($1 = 10 pts)
  d.prepare("UPDATE markets SET total_volume=?, volume24hr=? WHERE id=?")
    .run(Math.round(vol * 10), Math.round(vol24 * 10), marketId);
}

// ── Ensure DB schema exists
function ensureSchema() {
  const d = db();
  try {
    d.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id              TEXT PRIMARY KEY,
        username        TEXT UNIQUE NOT NULL,
        email           TEXT UNIQUE NOT NULL,
        password_hash   TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        bio             TEXT DEFAULT '',
        avatar_url      TEXT DEFAULT '',
        coins           INTEGER DEFAULT 500,
        total_predictions INTEGER DEFAULT 0,
        correct_predictions INTEGER DEFAULT 0,
        current_streak  INTEGER DEFAULT 0,
        longest_streak  INTEGER DEFAULT 0,
        last_login      TEXT,
        referral_code   TEXT UNIQUE,
        referred_by     TEXT,
        is_premium      INTEGER DEFAULT 0,
        premium_until   TEXT,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS markets (
        id              TEXT PRIMARY KEY,
        question        TEXT NOT NULL,
        description     TEXT DEFAULT '',
        category        TEXT DEFAULT 'general',
        creator_id      TEXT REFERENCES users(id),
        resolution_type TEXT DEFAULT 'binary',
        resolution_url  TEXT DEFAULT '',
        outcomes       TEXT DEFAULT '[]',
        status          TEXT DEFAULT 'active',
        outcome         TEXT DEFAULT '',
        yes_pool        INTEGER DEFAULT 0,
        no_pool         INTEGER DEFAULT 0,
        total_volume    INTEGER DEFAULT 0,
        volume24hr      INTEGER DEFAULT 0,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now')),
        closes_at       TEXT,
        resolved_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS market_options (
        id              TEXT PRIMARY KEY,
        market_id       TEXT NOT NULL REFERENCES markets(id),
        outcome_name    TEXT NOT NULL,
        current_price   REAL DEFAULT 0.5,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS price_history (
        id              TEXT PRIMARY KEY,
        market_id       TEXT NOT NULL REFERENCES markets(id),
        outcome_index   INTEGER NOT NULL,
        price           REAL NOT NULL,
        recorded_at     TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS predictions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id),
        market_id       NOT NULL REFERENCES markets(id),
        outcome         TEXT NOT NULL,
        coins_at_stake  INTEGER NOT NULL,
        odds_at_time    REAL NOT NULL,
        confidence      INTEGER DEFAULT 50,
        is_correct      INTEGER,
        coins_returned  INTEGER DEFAULT 0,
        placed_at       TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS coin_transactions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id),
        amount          INTEGER NOT NULL,
        type            TEXT NOT NULL,
        description     TEXT NOT NULL,
        reference_id    TEXT,
        balance_after   INTEGER NOT NULL,
        created_at      TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS redemptions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id),
        prize_type      TEXT NOT NULL,
        prize_label     TEXT NOT NULL,
        coins_cost      INTEGER NOT NULL,
        status          TEXT DEFAULT 'pending',
        fulfillment_data TEXT DEFAULT '',
        created_at      TEXT DEFAULT (datetime('now')),
        fulfilled_at    TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_logins (
        user_id         TEXT NOT NULL REFERENCES users(id),
        login_date      TEXT NOT NULL,
        coins_awarded   INTEGER DEFAULT 10,
        PRIMARY KEY (user_id, login_date)
      );

      CREATE TABLE IF NOT EXISTS referrals (
        id              TEXT PRIMARY KEY,
        referrer_id     TEXT NOT NULL REFERENCES users(id),
        referred_id     TEXT NOT NULL UNIQUE REFERENCES users(id),
        coins_awarded_referrer INTEGER DEFAULT 100,
        coins_awarded_referred INTEGER DEFAULT 200,
        created_at      TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_predictions_user ON predictions(user_id);
      CREATE INDEX IF NOT EXISTS idx_predictions_market ON predictions(market_id);
      CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
      CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
      CREATE INDEX IF NOT EXISTS idx_market_options_market ON market_options(market_id);
      CREATE INDEX IF NOT EXISTS idx_price_history_market ON price_history(market_id);
    `);

    // Migration: rename old 'options' column to 'outcomes' (SQLite 3.25+)
    try {
      d.exec("ALTER TABLE markets RENAME COLUMN options TO outcomes");
      console.log("[QADR] Migrated: options → outcomes");
    } catch(e) {
      // Column already renamed or doesn't exist — fine
    }
  } finally {
    d.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

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

// ── MARKETS — served from our own DB (cached from Polymarket)
app.get("/api/markets", (req, res) => {
  const d = db();
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const category = req.query.category || "";
    const search = req.query.q || "";
    const sort = req.query.order || "volume24hr";

    let where = "WHERE status='active'";
    const params = [];
    if (category) { where += " AND category=?"; params.push(category); }
    if (search) { where += " AND (question LIKE ? OR description LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }

    const orderBy = sort === "volume" ? "total_volume" : "volume24hr";

    const markets = d.prepare(`
      SELECT m.*,
        (SELECT GROUP_CONCAT(current_price) FROM market_options WHERE market_id=m.id ORDER BY current_price DESC) as option_prices
      FROM markets m ${where}
      ORDER BY m.${orderBy} DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const result = markets.map(m => {
      const outcomes = JSON.parse(m.outcomes || "[]");
      const prices = (m.option_prices || "").split(",").map(p => parseFloat(p) || 0);
      return {
        id: m.id,
        question: m.question,
        description: m.description,
        category: m.category,
        outcomes,
        prices,
        volume24hr: m.volume24hr || 0,
        totalVolume: m.total_volume || 0,
        status: m.status,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      };
    });

    res.json(result);
  } catch (e) {
    console.error("[QADR] /api/markets error:", e.message);
    res.status(500).json({ error: "Failed to fetch markets" });
  } finally { d.close(); }
});

// ── Single market detail
app.get("/api/markets/:id", (req, res) => {
  const d = db();
  try {
    const m = d.prepare("SELECT * FROM markets WHERE id=?").get(req.params.id);
    if (!m) return res.status(404).json({ error: "Market not found" });

    const options = d.prepare("SELECT * FROM market_options WHERE market_id=? ORDER BY current_price DESC").all(req.params.id);
    const prices = options.map(o => o.current_price);
    const outcomeNames = options.map(o => o.outcome_name);

    res.json({
      id: m.id,
      question: m.question,
      description: m.description,
      category: m.category,
      outcomes: outcomeNames,
      prices,
      volume24hr: m.volume24hr || 0,
      totalVolume: m.total_volume || 0,
      status: m.status,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch market" });
  } finally { d.close(); }
});

// ── Price history for charts
app.get("/api/markets/:id/history", (req, res) => {
  const d = db();
  try {
    const marketId = req.params.id;
    // Get all price history points, grouped by outcome_index
    const rows = d.prepare(`
      SELECT outcome_index, price, recorded_at
      FROM price_history
      WHERE market_id = ?
      ORDER BY recorded_at ASC
    `).all(marketId);

    // Group by outcome_index
    const byOutcome = {};
    for (const r of rows) {
      if (!byOutcome[r.outcome_index]) byOutcome[r.outcome_index] = [];
      byOutcome[r.outcome_index].push({ price: r.price, time: r.recorded_at });
    }

    res.json(byOutcome);
  } catch (e) {
    res.json({});
  } finally { d.close(); }
});

// ── PREDICTIONS
app.post("/api/predict", auth, (req, res) => {
  const { marketId, outcome, coins } = req.body;
  if (!marketId || outcome === undefined || !coins) return res.status(400).json({ error: "Missing fields" });
  if (coins < 10) return res.status(400).json({ error: "Min 10 coins" });

  const d = db();
  try {
    const market = d.prepare("SELECT * FROM markets WHERE id=?").get(marketId);
    if (!market) return res.status(400).json({ error: "Market not found" });

    const u = d.prepare("SELECT coins FROM users WHERE id=?").get(req.user.userId);
    if (u.coins < coins) return res.status(400).json({ error: `Need ${coins} coins, have ${u.coins}` });

    const outcomes = JSON.parse(market.outcomes || "[]");
    const outcomeIdx = parseInt(outcome);
    if (outcomeIdx < 0 || outcomeIdx >= outcomes.length) return res.status(400).json({ error: "Invalid outcome" });

    const optRow = d.prepare("SELECT * FROM market_options WHERE market_id=? AND outcome_name=?").get(marketId, outcomes[outcomeIdx]);
    const price = optRow ? optRow.current_price : 0.5;

    const id = uuid();
    d.prepare("INSERT INTO predictions (id,user_id,market_id,outcome,coins_at_stake,odds_at_time) VALUES (?,?,?,?,?,?)")
      .run(id, req.user.userId, marketId, String(outcomeIdx), coins, price);

    // Update pools
    d.prepare("UPDATE markets SET total_volume = total_volume + ? WHERE id=?").run(coins, marketId);

    awardCoins(d, req.user.userId, -coins, "prediction", `Predicted "${outcomes[outcomeIdx]}" on "${market.question.slice(0,40)}"`, id);

    res.json({ id, coins: u.coins - coins, outcome: outcomes[outcomeIdx], price });
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
    const recent = d.prepare("SELECT 1 FROM coin_transactions WHERE user_id=? AND type='ad_view' AND created_at > datetime('now','-5 minutes')").get(req.user.userId);
    if (recent) return res.status(429).json({ error: "Wait 5 minutes" });
    const coins = awardCoins(d, req.user.userId, 15, "ad_view", "Watched sponsored content");
    res.json({ awarded: 15, coins });
  } finally { d.close(); }
});

// ── CATEGORIES
app.get("/api/categories", (req, res) => {
  res.json([
    { id: "", label: "All", icon: "🔥" },
    { id: "politics", label: "Politics", icon: "🏛️" },
    { id: "sports", label: "Sports", icon: "⚽" },
    { id: "crypto", label: "Crypto", icon: "₿" },
    { id: "tech", label: "Tech", icon: "💻" },
    { id: "science", label: "Science", icon: "🔬" },
    { id: "economy", label: "Economy", icon: "📈" },
    { id: "geopolitics", label: "Geopolitics", icon: "🌍" },
  ]);
});

// ── FALLBACK
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

ensureSchema();

// Initial sync from Polymarket
syncMarketsFromPolymarket().then(() => {
  // Refresh every 60 seconds
  setInterval(syncMarketsFromPolymarket, 60000);
});

app.listen(PORT, "0.0.0.0", () => console.log(`Qadr running on port ${PORT}`));
