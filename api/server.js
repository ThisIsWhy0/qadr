// Qadr — Predict anything. Earn on everything. Real stakes, zero risk.
// Custom market platform — user-submitted, admin-approved
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, "..", "qadr.db");
const JWT_SECRET = process.env.JWT_SECRET || "qadr-scoped-" + uuid();
const SALT_ROUNDS = 10;
const ADMIN_USER_ID = "admin"; // First user is admin

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

// ── Admin check
function isAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "No token" });
  const d = db();
  try {
    const u = d.prepare("SELECT is_admin FROM users WHERE id=?").get(req.user.userId);
    if (!u || !u.is_admin) return res.status(403).json({ error: "Admin only" });
    next();
  } finally { d.close(); }
}

// ── Coin helper
function awardCoins(d, userId, amount, type, desc, refId) {
  d.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").run(amount, userId);
  const bal = d.prepare("SELECT coins FROM users WHERE id = ?").get(userId).coins;
  d.prepare("INSERT INTO coin_transactions (id,user_id,amount,type,description,reference_id,balance_after) VALUES (?,?,?,?,?,?,?)")
    .run(uuid(), userId, amount, type, desc, refId || null, bal);
  return bal;
}

// ── Ensure DB schema
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
        is_admin        INTEGER DEFAULT 0,
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
        outcomes        TEXT DEFAULT '[]',
        status          TEXT DEFAULT 'active',
        submission_status TEXT DEFAULT 'approved',
        outcome         TEXT DEFAULT '',
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
        market_id       TEXT NOT NULL REFERENCES markets(id),
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
      CREATE INDEX IF NOT EXISTS idx_markets_submission ON markets(submission_status);
      CREATE INDEX IF NOT EXISTS idx_market_options_market ON market_options(market_id);
      CREATE INDEX IF NOT EXISTS idx_price_history_market ON price_history(market_id);
    `);

    // Migrations for existing DBs
    try { d.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"); } catch(e) {}
    try { d.exec("ALTER TABLE markets ADD COLUMN submission_status TEXT DEFAULT 'approved'"); } catch(e) {}
    try { d.exec("ALTER TABLE markets RENAME COLUMN options TO outcomes"); } catch(e) {}
  } finally {
    d.close();
  }
}

// ── Seed custom markets
function seedMarkets() {
  const d = db();
  try {
    const count = d.prepare("SELECT COUNT(*) as c FROM markets").get();
    if (count.c > 0) return; // Don't overwrite existing markets

    const markets = [
      // 🏀 Sports
      { q: "Will the Sacramento Kings make the 2027 NBA playoffs?", desc: "California's team returns to form", cat: "sports", type: "binary", outcomes: ["Yes, they'll make it", "No, they'll miss"] },
      { q: "Who will win the 2027 NBA Championship?", desc: "Next season's title winner", cat: "sports", type: "multiple", outcomes: ["Boston Celtics", "Denver Nuggets", "Oklahoma City Thunder", "Los Angeles Lakers", "Milwaukee Bucks", "Other"] },
      { q: "Will Shohei Ohtani hit 50+ HRs in 2027?", desc: "The two-way superstar's power surge", cat: "sports", type: "binary", outcomes: ["50+ home runs", "Under 50 home runs"] },
      { q: "Which team will win the 2027 Super Bowl?", desc: "NFL's biggest game", cat: "sports", type: "multiple", outcomes: ["Kansas City Chiefs", "San Francisco 49ers", "Dallas Cowboys", "Philadelphia Eagles", "Buffalo Bills", "Other"] },
      { q: "Will Lionel Messi play in the 2026 World Cup?", desc: "The GOAT's World Cup farewell", cat: "sports", type: "binary", outcomes: ["Yes, he'll play", "No, he won't"] },
      { q: "Will an American win a Grand Slam in 2027?", desc: "Tennis Grand Slam singles title", cat: "sports", type: "binary", outcomes: ["Yes", "No"] },
      { q: "Will the 49ers have a winning season in 2026?", desc: "NFC West contenders", cat: "sports", type: "binary", outcomes: ["Above .500", "Below .500"] },

      // 💻 Tech
      { q: "Will Apple release an iPhone with a foldable screen by end of 2027?", desc: "The long-rumored foldable iPhone", cat: "tech", type: "binary", outcomes: ["Yes, foldable iPhone", "No foldable iPhone"] },
      { q: "Which company will have the best AI model by end of 2027?", desc: "Race for AI dominance", cat: "tech", type: "multiple", outcomes: ["OpenAI", "Google DeepMind", "Anthropic", "Meta", "Apple", "Chinese company", "Other"] },
      { q: "Will Tesla launch a $25,000 car by 2028?", desc: "The budget EV", cat: "tech", type: "binary", outcomes: ["Yes, under $25K", "No, above $25K"] },
      { q: "Will the next iPhone be USB-C only (no Lightning)?", desc: "Apple's port transition", cat: "tech", type: "binary", outcomes: ["USB-C only", "Still has Lightning or portless"] },
      { q: "Will a humanoid robot be sold to consumers by 2028?", desc: "Real robot butlers", cat: "tech", type: "binary", outcomes: ["Yes", "No"] },
      { q: "Will VR headset sales surpass 30 million in 2027?", desc: "Virtual reality goes mainstream", cat: "tech", type: "binary", outcomes: ["Over 30M sold", "Under 30M sold"] },

      // 🏛️ Politics
      { q: "Will gas prices in California drop below $4.00/gallon by end of 2027?", desc: "California energy policy", cat: "politics", type: "binary", outcomes: ["Below $4", "Above $4"] },
      { q: "Will California minimum wage reach $20/hr by 2028?", desc: "California labor policy", cat: "politics", type: "binary", outcomes: ["Yes, $20+", "No, under $20"] },
      { q: "Which party will win the 2028 US Presidential Election?", desc: "The next commander in chief", cat: "politics", type: "multiple", outcomes: ["Democrat", "Republican", "Independent / Third Party"] },
      { q: "Will the US pass a federal AI regulation bill by 2027?", desc: "AI governance", cat: "politics", type: "binary", outcomes: ["Yes", "No"] },

      // 🌍 Geopolitics
      { q: "Will the Strait of Hormuz be disrupted by the end of 2026?", desc: "Global oil supply chokepoint", cat: "geopolitics", type: "binary", outcomes: ["Yes, some disruption", "No major disruption"] },
      { q: "Will a major earthquake (7.0+) hit California by 2028?", desc: "The big one — seismic forecasting", cat: "geopolitics", type: "binary", outcomes: ["Yes, 7.0+", "No"] },
      { q: "Will a new US-China trade war start by end of 2026?", desc: "Economic tensions escalate", cat: "geopolitics", type: "binary", outcomes: ["Yes", "No"] },

      // 📈 Economy
      { q: "Will Bitcoin surpass $150,000 by end of 2027?", desc: "Crypto price prediction", cat: "crypto", type: "binary", outcomes: ["Above $150K", "Below $150K"] },
      { q: "Which will perform better in 2027?", desc: "Crypto rivals", cat: "crypto", type: "multiple", outcomes: ["Bitcoin", "Ethereum", "Solana", "None — all down"] },
      { q: "Will the Fed cut interest rates in 2026?", desc: "Federal Reserve policy", cat: "economy", type: "binary", outcomes: ["Yes", "No"] },
      { q: "Will US inflation be above 3% by end of 2026?", desc: "CPI measurement", cat: "economy", type: "binary", outcomes: ["Above 3%", "Below 3%"] },

      // 🔬 Science
      { q: "Will SpaceX land humans on Mars by 2030?", desc: "The red planet mission", cat: "science", type: "binary", outcomes: ["Yes", "No"] },
      { q: "Will a new COVID-like pandemic emerge by 2028?", desc: "Global health risk", cat: "science", type: "binary", outcomes: ["Yes", "No"] },
      { q: "Will a major solar flare cause significant disruption by 2027?", desc: "Solar storm risk", cat: "science", type: "binary", outcomes: ["Yes", "No"] },

      // 🎯 Fun / Pop Culture
      { q: "Which movie will win Best Picture at the 2027 Oscars?", desc: "Academy Awards prediction", cat: "entertainment", type: "multiple", outcomes: ["A new IP", "A sequel/reboot", "An indie film", "A streaming original"] },
      { q: "Will TikTok be banned in the US by end of 2027?", desc: "Social media regulation", cat: "entertainment", type: "binary", outcomes: ["Yes, banned", "No, it stays"] },
      { q: "Will GTA VI be released in 2026?", desc: "Most anticipated game ever", cat: "entertainment", type: "binary", outcomes: ["2026 release", "Delayed to 2027+"] },
      { q: "Will a US city get a new MLS team by 2028?", desc: "MLS expansion", cat: "sports", type: "binary", outcomes: ["Yes", "No"] },
    ];

    for (const m of markets) {
      const marketId = "mkt-" + uuid().slice(0, 8);
      const now = new Date().toISOString();
      d.prepare("INSERT INTO markets (id,question,description,category,resolution_type,outcomes,status,submission_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(marketId, m.q, m.desc, m.cat, m.type, JSON.stringify(m.outcomes), "active", "approved", now, now);

      // Seed market_options with equal prices
      for (let i = 0; i < m.outcomes.length; i++) {
        const optId = marketId + "-opt-" + i;
        const price = 1.0 / m.outcomes.length;
        d.prepare("INSERT INTO market_options (id,market_id,outcome_name,current_price,created_at,updated_at) VALUES (?,?,?,?,?,?)")
          .run(optId, marketId, m.outcomes[i], price, now, now);
        // Seed a single price history point
        d.prepare("INSERT INTO price_history (id,market_id,outcome_index,price,recorded_at) VALUES (?,?,?,?,?)")
          .run(uuid(), marketId, i, price, now);
      }
    }
    console.log(`[QADR] Seeded ${markets.length} custom markets`);
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

    const userCount = d.prepare("SELECT COUNT(*) as c FROM users").get();
    const isFirstUser = userCount.c === 0;

    const id = uuid(), hash = bcrypt.hashSync(password, SALT_ROUNDS), ref = uuid().slice(0, 8);
    let refBy = null, startCoins = 500;
    if (referralCode) {
      const r = d.prepare("SELECT id FROM users WHERE referral_code=?").get(referralCode);
      if (r) { refBy = r.id; startCoins += 200; }
    }
    d.prepare("INSERT INTO users (id,username,email,password_hash,display_name,coins,referral_code,referred_by,is_admin) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, username, email, hash, displayName||username, startCoins, ref, refBy, isFirstUser ? 1 : 0);
    awardCoins(d, id, 500, "signup_bonus", "Welcome to Qadr! 500 coins on the house.");
    if (refBy) {
      awardCoins(d, refBy, 100, "referral", `${username} joined via your code!`, id);
      d.prepare("INSERT INTO referrals (id,referrer_id,referred_id) VALUES (?,?,?)").run(uuid(), refBy, id);
    }
    const token = jwt.sign({ userId: id, username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id, username, displayName: displayName||username, coins: startCoins, isAdmin: isFirstUser } });
  } finally { d.close(); }
});

app.post("/api/auth/signin", (req, res) => {
  const { username, password } = req.body;
  const d = db();
  try {
    const u = d.prepare("SELECT * FROM users WHERE username=? OR email=?").get(username, username);
    if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign({ userId: u.id, username: u.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id:u.id, username:u.username, displayName:u.display_name, email:u.email, coins:u.coins, referralCode:u.referral_code, totalPredictions:u.total_predictions, correctPredictions:u.correct_predictions, currentStreak:u.current_streak, isAdmin: !!u.is_admin } });
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

// ── MARKETS — custom, from our own DB
app.get("/api/markets", (req, res) => {
  const d = db();
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const category = req.query.category || "";
    const search = req.query.q || "";
    const sort = req.query.order || "volume24hr";

    let where = "WHERE status='active' AND submission_status='approved'";
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

app.get("/api/markets/:id", (req, res) => {
  const d = db();
  try {
    const m = d.prepare("SELECT * FROM markets WHERE id=? AND submission_status='approved'").get(req.params.id);
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

app.get("/api/markets/:id/history", (req, res) => {
  const d = db();
  try {
    const marketId = req.params.id;
    const rows = d.prepare(`
      SELECT outcome_index, price, recorded_at
      FROM price_history
      WHERE market_id = ?
      ORDER BY recorded_at ASC
    `).all(marketId);

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

// ── SUBMIT A NEW MARKET (user-created, pending approval)
app.post("/api/markets/submit", auth, (req, res) => {
  const { question, description, category, outcomes } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: "Question required" });
  if (!outcomes || !Array.isArray(outcomes) || outcomes.length < 2)
    return res.status(400).json({ error: "Need at least 2 outcomes" });
  if (outcomes.length > 10) return res.status(400).json({ error: "Max 10 outcomes" });

  // Validate outcome names
  const cleanOutcomes = outcomes.map(o => String(o).trim()).filter(o => o.length > 0);
  if (cleanOutcomes.length < 2) return res.status(400).json({ error: "Need at least 2 non-empty outcomes" });

  const d = db();
  try {
    const marketCount = d.prepare("SELECT COUNT(*) as c FROM markets WHERE creator_id=? AND submission_status='pending'").get(req.user.userId);
    if (marketCount.c >= 3) return res.status(400).json({ error: "You can have max 3 pending submissions" });

    const cat = category && typeof category === "string" ? category.trim().toLowerCase().slice(0, 20) : "general";
    const marketId = "mkt-" + uuid().slice(0, 8);
    const now = new Date().toISOString();
    const isBinary = cleanOutcomes.length === 2 ? "binary" : "multiple";
    const prices = cleanOutcomes.map(() => 1.0 / cleanOutcomes.length);

    d.prepare("INSERT INTO markets (id,question,description,category,creator_id,resolution_type,outcomes,status,submission_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(marketId, question.trim(), (description||"").trim(), cat, req.user.userId, isBinary, JSON.stringify(cleanOutcomes), "active", "pending", now, now);

    for (let i = 0; i < cleanOutcomes.length; i++) {
      const optId = marketId + "-opt-" + i;
      d.prepare("INSERT INTO market_options (id,market_id,outcome_name,current_price,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(optId, marketId, cleanOutcomes[i], prices[i], now, now);
      d.prepare("INSERT INTO price_history (id,market_id,outcome_index,price,recorded_at) VALUES (?,?,?,?,?)")
        .run(uuid(), marketId, i, prices[i], now);
    }

    res.json({ id: marketId, message: "Market submitted for review. It will appear once approved by an admin." });
  } finally { d.close(); }
});

// ── SEE MY SUBMISSIONS
app.get("/api/markets/my-submissions", auth, (req, res) => {
  const d = db();
  try {
    const markets = d.prepare("SELECT id,question,category,submission_status,created_at FROM markets WHERE creator_id=? ORDER BY created_at DESC").all(req.user.userId);
    res.json(markets);
  } finally { d.close(); }
});

// ── ADMIN: pending submissions
app.get("/api/admin/pending-markets", auth, isAdmin, (req, res) => {
  const d = db();
  try {
    const markets = d.prepare(`
      SELECT m.*, u.username as creator_name
      FROM markets m LEFT JOIN users u ON m.creator_id=u.id
      WHERE m.submission_status='pending'
      ORDER BY m.created_at DESC
    `).all();
    res.json(markets);
  } finally { d.close(); }
});

// ── ADMIN: approve a market
app.post("/api/admin/approve-market/:id", auth, isAdmin, (req, res) => {
  const d = db();
  try {
    const m = d.prepare("SELECT * FROM markets WHERE id=? AND submission_status='pending'").get(req.params.id);
    if (!m) return res.status(404).json({ error: "Market not found or already processed" });
    const now = new Date().toISOString();
    d.prepare("UPDATE markets SET submission_status='approved', updated_at=? WHERE id=?").run(now, req.params.id);

    // Award creator with coins for approved market
    if (m.creator_id) {
      awardCoins(d, m.creator_id, 100, "market_approved", `Your market "${m.question.slice(0,40)}" was approved!`, m.id);
    }

    res.json({ message: "Market approved" });
  } finally { d.close(); }
});

// ── ADMIN: reject a market
app.post("/api/admin/reject-market/:id", auth, isAdmin, (req, res) => {
  const d = db();
  try {
    const m = d.prepare("SELECT * FROM markets WHERE id=? AND submission_status='pending'").get(req.params.id);
    if (!m) return res.status(404).json({ error: "Market not found or already processed" });
    d.prepare("UPDATE markets SET submission_status='rejected', status='inactive' WHERE id=?").run(req.params.id);
    res.json({ message: "Market rejected" });
  } finally { d.close(); }
});

// ── PREDICTIONS
app.post("/api/predict", auth, (req, res) => {
  const { marketId, outcome, coins } = req.body;
  if (!marketId || outcome === undefined || !coins) return res.status(400).json({ error: "Missing fields" });
  if (coins < 10) return res.status(400).json({ error: "Min 10 coins" });

  const d = db();
  try {
    const market = d.prepare("SELECT * FROM markets WHERE id=? AND status='active' AND submission_status='approved'").get(marketId);
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
    const u = d.prepare("SELECT id,username,display_name,email,coins,bio,total_predictions,correct_predictions,current_streak,longest_streak,is_premium,is_admin,referral_code,created_at FROM users WHERE id=?").get(req.user.userId);
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
    { id: "sports", label: "Sports", icon: "🏀" },
    { id: "tech", label: "Tech", icon: "💻" },
    { id: "politics", label: "Politics", icon: "🏛️" },
    { id: "geopolitics", label: "Geopolitics", icon: "🌍" },
    { id: "economy", label: "Economy", icon: "📈" },
    { id: "crypto", label: "Crypto", icon: "₿" },
    { id: "science", label: "Science", icon: "🔬" },
    { id: "entertainment", label: "Entertainment", icon: "🎬" },
  ]);
});

// ── FALLBACK
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

ensureSchema();
seedMarkets();

app.listen(PORT, "0.0.0.0", () => {
  const d = db();
  const mc = d.prepare("SELECT COUNT(*) as c FROM markets WHERE submission_status='approved'").get();
  d.close();
  console.log(`Qadr running on port ${PORT} — ${mc.c} markets loaded`);
});
