// Initialize Qadr database
const sqlite3 = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "qadr.db");

function init() {
  const db = new sqlite3(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  // Seed initial markets
  const markets = [
    ["m1", "Will the Sacramento Kings make the 2027 NBA Playoffs?", "The Kings need to finish in the top 10 of the Western Conference.", "sports", "binary"],
    ["m2", "Will Bitcoin be above $100,000 on December 31, 2026?", "Based on CoinGecko closing price on Dec 31, 2026.", "crypto", "binary"],
    ["m3", "Which team will win Super Bowl LII (2028)?", "The 52nd Super Bowl in February 2028.", "sports", "multiple"],
    ["m4", "Will UC Davis admit a student for Computer Engineering Fall 2028?", "Based on official UC Davis admission decisions for Fall 2028.", "custom", "binary"],
    ["m5", "Will AI pass the Turing Test by 2030?", "Human judges cannot distinguish AI from human responses better than chance.", "tech", "binary"],
    ["m6", "Will the US Federal Reserve cut interest rates in Q1 2027?", "Based on FOMC meeting decisions Jan-Mar 2027.", "politics", "binary"],
    ["m7", "Will SpaceX land humans on Mars by 2030?", "A crewed SpaceX mission successfully lands on Mars.", "science", "binary"],
    ["m8", "Will the iPhone 18 have a foldable display?", "Apple announces a foldable iPhone model as iPhone 18.", "tech", "binary"],
  ];

  const insert = db.prepare(
    "INSERT OR IGNORE INTO markets (id, question, description, category, resolution_type, status, closes_at) VALUES (?, ?, ?, ?, ?, 'active', datetime('now', '+30 days'))"
  );

  for (const m of markets) {
    insert.run(...m);
  }

  const count = db.prepare("SELECT COUNT(*) as c FROM markets").get();
  console.log(`Database initialized at ${DB_PATH}`);
  console.log(`Markets seeded: ${count.c}`);
  db.close();
}

init();
