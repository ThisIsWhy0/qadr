const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = 8080;
const DB_PATH = path.join(__dirname, 'qadr.db');

// ── Database ──────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    coins INTEGER DEFAULT 500,
    total_predictions INTEGER DEFAULT 0,
    correct_predictions INTEGER DEFAULT 0,
    streak INTEGER DEFAULT 0,
    last_login TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    is_premium INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS markets (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    creator_id TEXT,
    status TEXT DEFAULT 'active',
    outcome TEXT,
    closes_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    total_volume INTEGER DEFAULT 0,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    coins_staked INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    resolved INTEGER DEFAULT 0,
    won INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (market_id) REFERENCES markets(id)
  );

  CREATE TABLE IF NOT EXISTS trivia_questions (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    correct_answer INTEGER NOT NULL,
    difficulty TEXT DEFAULT 'medium',
    category TEXT DEFAULT 'general',
    reward INTEGER DEFAULT 20
  );

  CREATE TABLE IF NOT EXISTS trivia_attempts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    correct INTEGER NOT NULL,
    coins_earned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (question_id) REFERENCES trivia_questions(id)
  );

  CREATE TABLE IF NOT EXISTS daily_challenges (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    reward INTEGER NOT NULL,
    target INTEGER NOT NULL,
    UNIQUE(date, type)
  );

  CREATE TABLE IF NOT EXISTS challenge_completions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    completed_at TEXT DEFAULT (datetime('now')),
    coins_earned INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (challenge_id) REFERENCES daily_challenges(id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    prize TEXT NOT NULL,
    cost INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS daily_logins (
    user_id TEXT PRIMARY KEY,
    last_date TEXT,
    streak INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ── Seed Data ─────────────────────────────────────────────────────
function seedData() {
  // Seed markets
  const mc = db.prepare('SELECT COUNT(*) as c FROM markets').get();
  if (mc.c === 0) {
    const s = db.prepare('INSERT INTO markets (id, question, description, category, closes_at) VALUES (?,?,?,?,?)');
    const markets = [
      [uuidv4(), "Will the Sacramento Kings make the playoffs this season?", "NBA Western Conference", "sports", "2027-04-15"],
      [uuidv4(), "Will gas prices in California drop below $4.00/gallon by end of 2027?", "California energy policy", "economics", "2027-12-31"],
      [uuidv4(), "Will the next iPhone be released in September 2027?", "Apple product launch prediction", "tech", "2027-09-30"],
      [uuidv4(), "Will Bitcoin exceed $100,000 by end of 2027?", "Cryptocurrency price prediction", "finance", "2027-12-31"],
      [uuidv4(), "Will Sacramento get a major league sports team by 2030?", "Sacramento sports expansion", "sports", "2030-01-01"],
      [uuidv4(), "Will AI pass a full Turing Test by 2030?", "AI milestone prediction", "tech", "2030-12-31"],
      [uuidv4(), "Will California minimum wage reach $20/hr by 2028?", "California labor policy", "politics", "2028-01-01"],
      [uuidv4(), "Will UC Davis CE TAG acceptance rate increase in 2028?", "UC Davis transfer admissions", "education", "2028-03-01"],
    ];
    for (const m of markets) s.run(...m);
    console.log(`Seeded ${markets.length} markets`);
  }

  // Seed trivia questions
  const tc = db.prepare('SELECT COUNT(*) as c FROM trivia_questions').get();
  if (tc.c === 0) {
    const s = db.prepare('INSERT INTO trivia_questions (id, question, options, correct_answer, difficulty, category, reward) VALUES (?,?,?,?,?,?,?)');
    const questions = [
      [uuidv4(), "What does CPU stand for?", '["Central Processing Unit","Computer Personal Unit","Central Program Utility","Core Processing Unit"]', 0, "easy", "tech", 15],
      [uuidv4(), "Which data structure uses LIFO?", '["Queue","Stack","Array","Tree"]', 1, "medium", "cs", 25],
      [uuidv4(), "What is the time complexity of binary search?", '["O(n)","O(log n)","O(n²)","O(1)"]', 1, "medium", "cs", 25],
      [uuidv4(), "Who is considered the father of the computer?", '["Alan Turing","Charles Babbage","John von Neumann","Steve Jobs"]', 1, "easy", "tech", 15],
      [uuidv4(), "What does HTML stand for?", '["Hyper Text Markup Language","High Tech Modern Language","Hyper Transfer Markup Language","Home Tool Markup Language"]', 0, "easy", "tech", 15],
      [uuidv4(), "Which sorting algorithm has the best average-case time complexity?", '["Bubble Sort","Quick Sort","Selection Sort","Insertion Sort"]', 1, "hard", "cs", 40],
      [uuidv4(), "What year was the first iPhone released?", '["2005","2006","2007","2008"]', 2, "easy", "tech", 15],
      [uuidv4(), "What is the capital of California?", '["Los Angeles","San Francisco","Sacramento","San Diego"]', 2, "easy", "geography", 10],
      [uuidv4(), "Which company created Java?", '["Microsoft","Sun Microsystems","Apple","IBM"]', 1, "medium", "tech", 25],
      [uuidv4(), "What does SQL stand for?", '["Structured Query Language","Simple Query Language","Standard Query Language","System Query Language"]', 0, "easy", "cs", 15],
      [uuidv4(), "What is 2^10?", '["512","1024","2048","256"]', 1, "easy", "math", 10],
      [uuidv4(), "Which protocol is used for secure web browsing?", '["HTTP","FTP","HTTPS","SMTP"]', 2, "medium", "tech", 25],
      [uuidv4(), "What is the hardest natural substance on Earth?", '["Gold","Iron","Diamond","Platinum"]', 2, "easy", "science", 15],
      [uuidv4(), "Which planet is closest to the Sun?", '["Venus","Earth","Mercury","Mars"]', 2, "easy", "science", 10],
      [uuidv4(), "What is the main function of RAM?", '["Permanent storage","Temporary data access","Processing data","Display output"]', 1, "medium", "cs", 25],
    ];
    for (const q of questions) s.run(...q);
    console.log(`Seeded ${questions.length} trivia questions`);
  }

  // Seed daily challenges
  const today = new Date().toISOString().split('T')[0];
  const cc = db.prepare('SELECT COUNT(*) as c FROM daily_challenges WHERE date = ?').get(today);
  if (cc.c === 0) {
    const s = db.prepare('INSERT INTO daily_challenges (id, date, type, description, reward, target) VALUES (?,?,?,?,?,?)');
    const challenges = [
      [uuidv4(), today, "predictions", "Make 3 predictions today", 30, 3],
      [uuidv4(), today, "trivia", "Answer 5 trivia questions", 25, 5],
      [uuidv4(), today, "login", "Log in today", 10, 1],
      [uuidv4(), today, "streak", "Maintain a 3-day streak", 50, 3],
    ];
    for (const c of challenges) s.run(...c);
    console.log(`Seeded ${challenges.length} daily challenges for ${today}`);
  }
}
seedData();

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── Auth Routes ───────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?,?,?,?)').run(id, username, email, hash);
    db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?,?,?,?,?)').run(uuidv4(), id, 'bonus', 500, 'Welcome bonus — start earning!');
    res.json({ token: id, user: { id, username, email, coins: 500, streak: 0, total_predictions: 0, correct_predictions: 0 } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username or email already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: user.id, user: { id: user.id, username: user.username, email: user.email, coins: user.coins, streak: user.streak, total_predictions: user.total_predictions, correct_predictions: user.correct_predictions } });
});

// ── Daily Login Bonus ─────────────────────────────────────────────
app.post('/api/daily-login', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const login = db.prepare('SELECT * FROM daily_logins WHERE user_id = ?').get(req.user.id);
  let newStreak = 1;
  if (login) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    if (login.last_date === yesterday) newStreak = login.streak + 1;
    else if (login.last_date === today) return res.json({ message: 'Already claimed!', streak: login.streak, bonus: 0, coins: req.user.coins });
  }
  const bonus = 10 + (newStreak >= 7 ? 50 : 0) + (newStreak >= 30 ? 100 : 0);
  db.prepare('UPDATE users SET coins = coins + ?, streak = ?, last_login = ? WHERE id = ?').run(bonus, newStreak, today, req.user.id);
  db.prepare('INSERT OR REPLACE INTO daily_logins (user_id, last_date, streak) VALUES (?,?,?)').run(req.user.id, today, newStreak);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, 'daily', bonus, `Day ${newStreak} login bonus`);
  res.json({ bonus, streak: newStreak, coins: req.user.coins + bonus });
});

// ── Trivia ────────────────────────────────────────────────────────
app.get('/api/trivia', auth, (req, res) => {
  const attempts = db.prepare('SELECT question_id FROM trivia_attempts WHERE user_id = ?').all(req.user.id).map(a => a.question_id);
  let question;
  if (attempts.length > 0) {
    const placeholders = attempts.map(() => '?').join(',');
    question = db.prepare(`SELECT * FROM trivia_questions WHERE id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`).get(...attempts);
  }
  if (!question) question = db.prepare('SELECT * FROM trivia_questions ORDER BY RANDOM() LIMIT 1').get();
  
  if (!question) return res.json({ done: true, message: 'You answered all questions! Check back tomorrow.' });
  
  res.json({
    id: question.id,
    question: question.question,
    options: JSON.parse(question.options),
    difficulty: question.difficulty,
    category: question.category,
    reward: question.reward
  });
});

app.post('/api/trivia/answer', auth, (req, res) => {
  const { question_id, answer } = req.body;
  const question = db.prepare('SELECT * FROM trivia_questions WHERE id = ?').get(question_id);
  if (!question) return res.status(400).json({ error: 'Question not found' });
  
  const already = db.prepare('SELECT * FROM trivia_attempts WHERE user_id = ? AND question_id = ?').get(req.user.id, question_id);
  if (already) return res.status(400).json({ error: 'Already answered this question' });
  
  const correct = answer === question.correct_answer;
  const coinsEarned = correct ? question.reward : 5;
  
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coinsEarned, req.user.id);
  db.prepare('INSERT INTO trivia_attempts (id, user_id, question_id, correct, coins_earned) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, question_id, correct ? 1 : 0, coinsEarned);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, 'trivia', coinsEarned, correct ? `Trivia correct: +${coinsEarned}` : `Trivia attempt: +5`);
  
  res.json({
    correct,
    correct_answer: question.correct_answer,
    coins_earned: coinsEarned,
    coins: req.user.coins + coinsEarned
  });
});

// ── Daily Challenges ──────────────────────────────────────────────
app.get('/api/challenges', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  let challenges = db.prepare('SELECT * FROM daily_challenges WHERE date = ?').all(today);
  
  // Auto-generate if missing
  if (challenges.length === 0) {
    const types = [
      { type: 'predictions', desc: 'Make 3 predictions today', reward: 30, target: 3 },
      { type: 'trivia', desc: 'Answer 5 trivia questions', reward: 25, target: 5 },
      { type: 'login', desc: 'Log in today', reward: 10, target: 1 },
      { type: 'streak', desc: 'Maintain a 3-day streak', reward: 50, target: 3 },
    ];
    const s = db.prepare('INSERT INTO daily_challenges (id, date, type, description, reward, target) VALUES (?,?,?,?,?,?)');
    for (const t of types) { s.run(uuidv4(), today, t.type, t.desc, t.reward, t.target); }
    challenges = db.prepare('SELECT * FROM daily_challenges WHERE date = ?').all(today);
  }
  
  // Check completions
  for (const c of challenges) {
    const done = db.prepare('SELECT * FROM challenge_completions WHERE user_id = ? AND challenge_id = ?').get(req.user.id, c.id);
    c.completed = !!done;
    c.progress = 0;
    
    if (c.type === 'predictions') c.progress = db.prepare('SELECT COUNT(*) as c FROM predictions WHERE user_id = ? AND date(created_at) = ?').get(req.user.id, today).c;
    else if (c.type === 'trivia') c.progress = db.prepare('SELECT COUNT(*) as c FROM trivia_attempts WHERE user_id = ? AND date(created_at) = ?').get(req.user.id, today).c;
    else if (c.type === 'login') c.progress = 1;
    else if (c.type === 'streak') c.progress = Math.min(req.user.streak, c.target);
  }
  
  res.json(challenges);
});

app.post('/api/challenges/claim', auth, (req, res) => {
  const { challenge_id } = req.body;
  const challenge = db.prepare('SELECT * FROM daily_challenges WHERE id = ?').get(challenge_id);
  if (!challenge) return res.status(400).json({ error: 'Challenge not found' });
  
  const done = db.prepare('SELECT * FROM challenge_completions WHERE user_id = ? AND challenge_id = ?').get(req.user.id, challenge_id);
  if (done) return res.status(400).json({ error: 'Already claimed' });
  
  // Verify completion
  const today = new Date().toISOString().split('T')[0];
  let progress = 0;
  if (challenge.type === 'predictions') progress = db.prepare('SELECT COUNT(*) as c FROM predictions WHERE user_id = ? AND date(created_at) = ?').get(req.user.id, today).c;
  else if (challenge.type === 'trivia') progress = db.prepare('SELECT COUNT(*) as c FROM trivia_attempts WHERE user_id = ? AND date(created_at) = ?').get(req.user.id, today).c;
  else if (challenge.type === 'login') progress = 1;
  else if (challenge.type === 'streak') progress = req.user.streak;
  
  if (progress < challenge.target) return res.status(400).json({ error: `Need ${challenge.target - progress} more to complete` });
  
  db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(challenge.reward, req.user.id);
  db.prepare('INSERT INTO challenge_completions (id, user_id, challenge_id, coins_earned) VALUES (?,?,?,?)').run(uuidv4(), req.user.id, challenge_id, challenge.reward);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, 'challenge', challenge.reward, `Completed: ${challenge.description}`);
  
  res.json({ reward: challenge.reward, coins: req.user.coins + challenge.reward });
});

// ── Markets ───────────────────────────────────────────────────────
app.get('/api/markets', (req, res) => {
  const markets = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM predictions WHERE market_id=m.id) as prediction_count, (SELECT SUM(CASE WHEN choice='yes' THEN coins_staked ELSE 0 END) FROM predictions WHERE market_id=m.id) as yes_volume, (SELECT SUM(CASE WHEN choice='no' THEN coins_staked ELSE 0 END) FROM predictions WHERE market_id=m.id) as no_volume FROM markets m WHERE m.status='active' ORDER BY m.created_at DESC`).all();
  res.json(markets);
});

app.post('/api/markets', auth, (req, res) => {
  const { question, description, category, closes_at } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  if (req.user.coins < 500) return res.status(400).json({ error: 'Need 500 coins (create a prediction instead!)' });
  const id = uuidv4();
  db.prepare('UPDATE users SET coins = coins - 500 WHERE id = ?').run(req.user.id);
  db.prepare('INSERT INTO markets (id, question, description, category, creator_id, closes_at) VALUES (?,?,?,?,?,?)').run(id, question, description||'', category||'general', req.user.id, closes_at||null);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, 'market_creation', -500, `Created market`);
  res.json({ id, coins: req.user.coins - 500 });
});

// ── Predictions ───────────────────────────────────────────────────
app.post('/api/predict', auth, (req, res) => {
  const { market_id, choice, coins } = req.body;
  if (!market_id || !choice || !coins) return res.status(400).json({ error: 'All fields required' });
  if (!['yes','no'].includes(choice)) return res.status(400).json({ error: 'Choice must be yes or no' });
  if (coins < 10 || coins > 1000) return res.status(400).json({ error: 'Stake must be 10-1000' });
  const market = db.prepare('SELECT * FROM markets WHERE id=? AND status=?').get(market_id, 'active');
  if (!market) return res.status(400).json({ error: 'Market not available' });
  if (req.user.coins < coins) return res.status(400).json({ error: 'Not enough coins' });
  const existing = db.prepare('SELECT * FROM predictions WHERE user_id=? AND market_id=?').get(req.user.id, market_id);
  if (existing) return res.status(400).json({ error: 'Already predicted on this market' });
  
  const id = uuidv4();
  db.prepare('UPDATE users SET coins=coins-?, total_predictions=total_predictions+1 WHERE id=?').run(coins, req.user.id);
  db.prepare('INSERT INTO predictions (id,user_id,market_id,choice,coins_staked) VALUES (?,?,?,?,?)').run(id, req.user.id, market_id, choice, coins);
  db.prepare('UPDATE markets SET total_volume=total_volume+? WHERE id=?').run(coins, market_id);
  db.prepare('INSERT INTO transactions (id,user_id,type,amount,description) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, 'prediction', -coins, `Predicted ${choice}`);
  res.json({ id, coins: req.user.coins - coins });
});

app.post('/api/resolve/:marketId', auth, (req, res) => {
  const { outcome } = req.body;
  if (!['yes','no'].includes(outcome)) return res.status(400).json({ error: 'Outcome must be yes or no' });
  const market = db.prepare('SELECT * FROM markets WHERE id=?').get(req.params.marketId);
  if (!market) return res.status(404).json({ error: 'Not found' });
  if (market.creator_id !== req.user.id) return res.status(403).json({ error: 'Only creator can resolve' });
  db.prepare('UPDATE markets SET status=?, outcome=? WHERE id=?').run('resolved', outcome, req.params.marketId);
  
  const predictions = db.prepare('SELECT * FROM predictions WHERE market_id=? AND resolved=0').all(req.params.marketId);
  let totalPool = 0, winningPool = 0;
  for (const p of predictions) { totalPool += p.coins_staked; if (p.choice === outcome) winningPool += p.coins_staked; }
  for (const p of predictions) {
    const won = p.choice === outcome;
    db.prepare('UPDATE predictions SET resolved=1, won=? WHERE id=?').run(won?1:0, p.id);
    if (won && winningPool > 0) {
      const share = Math.floor((p.coins_staked / winningPool) * (totalPool - winningPool));
      const totalWin = p.coins_staked + share;
      db.prepare('UPDATE users SET coins=coins+?, correct_predictions=correct_predictions+1 WHERE id=?').run(totalWin, p.user_id);
      db.prepare('INSERT INTO transactions (id,user_id,type,amount,description) VALUES (?,?,?,?,?)').run(uuidv4(), p.user_id, 'win', totalWin, 'Prediction won!');
    }
  }
  res.json({ message: `Resolved: ${outcome}`, winners: predictions.filter(p=>p.choice===outcome).length });
});

// ── Leaderboard ───────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const top = db.prepare(`SELECT username, coins, total_predictions, correct_predictions, CASE WHEN total_predictions>0 THEN ROUND(correct_predictions*100.0/total_predictions,1) ELSE 0 END as accuracy FROM users ORDER BY coins DESC LIMIT 50`).all();
  res.json(top);
});

// ── User Profile ──────────────────────────────────────────────────
app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id,username,email,coins,total_predictions,correct_predictions,streak,is_premium,created_at FROM users WHERE id=?').get(req.user.id);
  const tx = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 15').all(req.user.id);
  const preds = db.prepare('SELECT p.*,m.question,m.outcome FROM predictions p JOIN markets m ON p.market_id=m.id WHERE p.user_id=? ORDER BY p.created_at DESC LIMIT 10').all(req.user.id);
  res.json({ user, transactions: tx, predictions: preds });
});

// ── Prize Redemption ──────────────────────────────────────────────
const PRIZES = [
  { name: '$5 Amazon Gift Card', cost: 5000, icon: '🛒' },
  { name: '$10 Starbucks Card', cost: 4000, icon: '☕' },
  { name: '$25 Visa Prepaid', cost: 10000, icon: '💳' },
  { name: '$50 Amazon Gift Card', cost: 20000, icon: '🛍️' },
  { name: 'Premium (1 month)', cost: 1000, icon: '⭐' },
];

app.get('/api/prizes', (req, res) => res.json(PRIZES));

app.post('/api/redeem', auth, (req, res) => {
  const { prizeName } = req.body;
  const prize = PRIZES.find(p => p.name === prizeName);
  if (!prize) return res.status(400).json({ error: 'Invalid prize' });
  if (req.user.coins < prize.cost) return res.status(400).json({ error: `Need ${prize.cost} coins` });
  db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(prize.cost, req.user.id);
  db.prepare('INSERT INTO redemptions (id, user_id, prize, cost) VALUES (?,?,?,?)').run(uuidv4(), req.user.id, prize.name, prize.cost);
  db.prepare('INSERT INTO transactions (id, user_id, type, amount, description) VALUES (?,?,?,?,?)').run(uuidv4(), req.user.id, 'redemption', -prize.cost, `Redeemed: ${prize.name}`);
  res.json({ message: `Redeemed ${prique.name}! Delivered via email within 24 hours.`, coins: req.user.coins - prize.cost });
});

// ── Stats ─────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const u = db.prepare('SELECT COUNT(*) as c FROM users').get();
  const m = db.prepare('SELECT COUNT(*) as c FROM markets').get();
  const p = db.prepare('SELECT COUNT(*) as c FROM predictions').get();
  const v = db.prepare('SELECT SUM(coins_staked) as s FROM predictions').get();
  res.json({ users: u.c, markets: m.c, predictions: p.c, totalVolume: v.s || 0 });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Qadr running on port ${PORT}`);
  console.log(`Trivia: ${db.prepare('SELECT COUNT(*) as c FROM trivia_questions').get().c} questions loaded`);
});
