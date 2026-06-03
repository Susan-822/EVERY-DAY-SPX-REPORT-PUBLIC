import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(__dirname, "..", "data", "trading.db");

// Ensure data folder exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log("Connected to the SQLite database.");
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    // Signals table
    db.run(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL, -- LONG, SHORT, NEUTRAL
        confidence REAL,
        reasoning TEXT,
        suggested_entry REAL,
        suggested_sl REAL,
        suggested_tp REAL,
        raw_tv_data TEXT,
        raw_uw_data TEXT,
        status TEXT DEFAULT 'PENDING' -- PENDING, APPROVED, REJECTED, EXECUTED
      )
    `);

    // Orders table
    db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        signal_id INTEGER,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        price REAL,
        quantity REAL,
        order_type TEXT,
        bitget_order_id TEXT,
        status TEXT, -- SUCCESS, FAILED, CANCELED
        pnl REAL DEFAULT 0, -- Realized P&L of this order (if flatting)
        error_message TEXT,
        FOREIGN KEY(signal_id) REFERENCES signals(id)
      )
    `);

    // Daily Stats table for wind-control (risk) tracking
    db.run(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY, -- 'YYYY-MM-DD'
        total_pnl REAL DEFAULT 0,
        consecutive_losses INTEGER DEFAULT 0,
        trading_halted INTEGER DEFAULT 0 -- 0 = active, 1 = halted
      )
    `);
  });
}

// Helper functions for DB queries
export function runQuery(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

export function allQuery(sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

export function getQuery(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * Risk Tracker Helpers
 */
export async function getDailyStats(dateStr: string): Promise<{
  date: string;
  total_pnl: number;
  consecutive_losses: number;
  trading_halted: number;
}> {
  const row = await getQuery("SELECT * FROM daily_stats WHERE date = ?", [dateStr]);
  if (!row) {
    // Initialize day record
    await runQuery(
      "INSERT OR IGNORE INTO daily_stats (date, total_pnl, consecutive_losses, trading_halted) VALUES (?, 0, 0, 0)",
      [dateStr]
    );
    return { date: dateStr, total_pnl: 0, consecutive_losses: 0, trading_halted: 0 };
  }
  return row;
}

export async function updateDailyStats(
  dateStr: string,
  pnlChange: number,
  isLoss: boolean
): Promise<void> {
  const stats = await getDailyStats(dateStr);
  const newPnl = stats.total_pnl + pnlChange;
  
  let newConsecutiveLosses = stats.consecutive_losses;
  if (isLoss) {
    newConsecutiveLosses += 1;
  } else if (pnlChange > 0) {
    newConsecutiveLosses = 0; // reset on profit
  }

  // Determine if trading should be halted based on rules:
  // - Daily loss hits -$50
  // - Consecutive losses hits 3
  let halted = stats.trading_halted;
  if (newPnl <= -50 || newConsecutiveLosses >= 3) {
    halted = 1;
  }

  await runQuery(
    "UPDATE daily_stats SET total_pnl = ?, consecutive_losses = ?, trading_halted = ? WHERE date = ?",
    [newPnl, newConsecutiveLosses, halted, dateStr]
  );
}

export async function resetDailyStats(dateStr: string): Promise<void> {
  await runQuery(
    "UPDATE daily_stats SET total_pnl = 0, consecutive_losses = 0, trading_halted = 0 WHERE date = ?",
    [dateStr]
  );
}
