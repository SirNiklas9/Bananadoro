import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'

const dbPath = process.env.DATABASE_PATH || './data/bananadoro.db'
const sqlite = new Database(dbPath)

// Create tables on startup
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS oauth_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    provider_username TEXT,
    created_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS native_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    email TEXT NOT NULL UNIQUE,
    username TEXT,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    work_duration INTEGER DEFAULT 25,
    break_duration INTEGER DEFAULT 5,
    sound_enabled INTEGER DEFAULT 1,
    notifications_enabled INTEGER DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS user_sessions (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    session_code TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS totp_secrets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    secret TEXT NOT NULL,
    verified INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recovery_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    code_hash TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
      );
`)

export const db = drizzle(sqlite)