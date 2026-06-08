-- Qadr Database Schema
-- Predict. Earn. Win.

-- Users
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    bio             TEXT DEFAULT '',
    avatar_url      TEXT DEFAULT '',
    coins           INTEGER DEFAULT 500,     -- starting bonus
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

-- Prediction Markets
CREATE TABLE IF NOT EXISTS markets (
    id              TEXT PRIMARY KEY,
    question        TEXT NOT NULL,
    description     TEXT DEFAULT '',
    category        TEXT DEFAULT 'general',
    -- categories: politics, sports, tech, science, crypto, entertainment, custom
    creator_id      TEXT REFERENCES users(id),
    -- How the market resolves
    resolution_type TEXT DEFAULT 'binary',    -- binary, multiple, numeric
    resolution_url  TEXT DEFAULT '',          -- link to source for resolution
    -- Outcomes for multiple choice
    options         TEXT DEFAULT '[]',        -- JSON array of outcome strings
    -- Market state
    status          TEXT DEFAULT 'active',    -- active, closed, resolved, cancelled
    outcome         TEXT DEFAULT '',          -- winning outcome (NULL until resolved)
    -- Bins for the coin system
    yes_pool        INTEGER DEFAULT 0,        -- total coins on "yes" / option 1
    no_pool         INTEGER DEFAULT 0,        -- total coins on "no" / last option
    total_volume    INTEGER DEFAULT 0,        -- total coins bet on this market
    -- Timestamps
    created_at      TEXT DEFAULT (datetime('now')),
    closes_at       TEXT,                     -- when predictions close
    resolved_at     TEXT
);

-- User predictions (coin bets)
CREATE TABLE IF NOT EXISTS predictions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    market_id       TEXT NOT NULL REFERENCES markets(id),
    outcome         TEXT NOT NULL,            -- which outcome they picked
    coins_at_stake  INTEGER NOT NULL,         -- coins placed
    odds_at_time    REAL NOT NULL,            -- implied odds when placed (e.g., 0.65)
    confidence      INTEGER DEFAULT 50,       -- 1-100 slider
    is_correct      INTEGER,                  -- NULL until resolved
    coins_returned  INTEGER DEFAULT 0,        -- coins returned after resolution (win = stake + profit)
    placed_at       TEXT DEFAULT (datetime('now'))
);

-- Coin transactions (audit trail)
CREATE TABLE IF NOT EXISTS coin_transactions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    amount          INTEGER NOT NULL,         -- positive = earn, negative = spend
    type            TEXT NOT NULL,            -- login, prediction, correct, streak, referral, ad_view, prize_redeem, market_create, premium_buy, daily_bonus, signup_bonus
    description     TEXT NOT NULL,
    reference_id    TEXT,                     -- e.g., prediction_id or market_id
    balance_after   INTEGER NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Prize redemptions
CREATE TABLE IF NOT EXISTS redemptions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    prize_type      TEXT NOT NULL,            -- amazon, starbucks, visa, premium
    prize_label     TEXT NOT NULL,
    coins_cost      INTEGER NOT NULL,
    status          TEXT DEFAULT 'pending',   -- pending, processing, fulfilled, cancelled
    fulfillment_data TEXT DEFAULT '',         -- email to send to, etc.
    created_at      TEXT DEFAULT (datetime('now')),
    fulfilled_at    TEXT
);

-- Leaderboard cache (rebuilt periodically)
CREATE TABLE IF NOT EXISTS leaderboard (
    user_id         TEXT PRIMARY KEY REFERENCES users(id),
    username        TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    total_correct   INTEGER DEFAULT 0,
    accuracy        REAL DEFAULT 0,
    total_coins_earned INTEGER DEFAULT 0,
    current_streak  INTEGER DEFAULT 0,
    rank            INTEGER DEFAULT 0,
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Daily login tracking
CREATE TABLE IF NOT EXISTS daily_logins (
    user_id         TEXT NOT NULL REFERENCES users(id),
    login_date      TEXT NOT NULL,
    coins_awarded   INTEGER DEFAULT 10,
    PRIMARY KEY (user_id, login_date)
);

-- Sponsored markets (revenue)
CREATE TABLE IF NOT EXISTS sponsored_markets (
    id              TEXT PRIMARY KEY,
    market_id       TEXT REFERENCES markets(id),
    sponsor_name    TEXT NOT NULL,
    sponsor_url     TEXT DEFAULT '',
    cost_usd        REAL DEFAULT 0,
    status          TEXT DEFAULT 'active',
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Referrals tracking
CREATE TABLE IF NOT EXISTS referrals (
    id              TEXT PRIMARY KEY,
    referrer_id     TEXT NOT NULL REFERENCES users(id),
    referred_id     TEXT NOT NULL UNIQUE REFERENCES users(id),
    coins_awarded_referrer INTEGER DEFAULT 100,
    coins_awarded_referred INTEGER DEFAULT 200,
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_predictions_user ON predictions(user_id);
CREATE INDEX IF NOT EXISTS idx_predictions_market ON predictions(market_id);
CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_coin_tx_type ON coin_transactions(type);
CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);
