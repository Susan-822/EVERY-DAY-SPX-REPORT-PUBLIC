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
        error_message TEXT,
        FOREIGN KEY(signal_id) REFERENCES signals(id)
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
