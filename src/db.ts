import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'host')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Événements de soirée (le code est lu dans le QR de la borne).
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  permit_join_until TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  ieee TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  vendor TEXT,
  description TEXT,
  name TEXT NOT NULL,
  location TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  online INTEGER NOT NULL DEFAULT 0,
  battery REAL,
  last_seen_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('binary', 'numeric', 'enum')),
  unit TEXT,
  enum_values TEXT,
  access TEXT NOT NULL CHECK (access IN ('read', 'write', 'readwrite')),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, name)
);

-- Mesures : une ligne par capacité et par message (valeur JSON).
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  ts TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_device_cap_ts ON readings (device_id, capability, ts);
CREATE INDEX IF NOT EXISTS readings_ts ON readings (ts);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  schedule TEXT,
  actions TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Journal des événements du parc.
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  device_id TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_ts ON journal (ts);

CREATE TABLE IF NOT EXISTS photos (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('booth', 'guest')),
  author_id TEXT NOT NULL,
  author_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS push_tokens (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Ouvre (ou crée) la base SQLite. `:memory:` pour les tests. */
export function openDb(dataDir: string, file = 'manora-live.db'): Db {
  let path = file;
  if (file !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, file);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Date ISO 8601 UTC à la seconde (`2026-11-12T09:41:07Z`). */
export function toIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const nowIso = () => toIso(new Date());
