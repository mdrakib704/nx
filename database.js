const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

// Ensure directories exist
Object.values(config.paths).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const db = new Database('nxpanel.db');
db.pragma('journal_mode = WAL');

// Initialize schema
function initDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            coins INTEGER DEFAULT 0,
            referral_code TEXT UNIQUE,
            referred_by TEXT,
            last_daily_reward DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            status TEXT DEFAULT 'offline',
            ram INTEGER NOT NULL,
            cpu INTEGER NOT NULL,
            storage INTEGER NOT NULL,
            startup_command TEXT,
            env_vars TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS backgrounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            type TEXT NOT NULL,
            is_active INTEGER DEFAULT 0,
            opacity REAL DEFAULT 1.0,
            blur INTEGER DEFAULT 0,
            brightness INTEGER DEFAULT 100,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS ads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            reward_coins INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Create default admin if not exists
    const adminCheck = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@nxpanel.local');
    if (!adminCheck) {
        const hash = bcrypt.hashSync('admin123', 10);
        const refCode = Math.random().toString(36).substring(2, 10).toUpperCase();
        db.prepare('INSERT INTO users (username, email, password, role, referral_code) VALUES (?, ?, ?, ?, ?)').run(
            'Admin', 'admin@nxpanel.local', hash, 'admin', refCode
        );
        console.log('[DB] Default admin created: admin@nxpanel.local / admin123');
    }
}

initDatabase();

module.exports = db;
