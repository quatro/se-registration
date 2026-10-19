import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

mkdirSync(path.dirname(config.dbPath), { recursive: true })
export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

-- A division is one league level (T-Ball, Minors, Majors, ...). Its seat
-- capacity is teams x roster_size; the teams count is set from fields and coaches.
CREATE TABLE IF NOT EXISTS divisions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  teams       INTEGER NOT NULL DEFAULT 0,
  roster_size INTEGER NOT NULL DEFAULT 12,
  coaches     INTEGER,                         -- head coaches lined up; flags teams without one
  min_age     INTEGER,                         -- league-age range: ages returners up, flags mismatches
  max_age     INTEGER,
  se_match    TEXT NOT NULL DEFAULT '',        -- comma-separated words matched against the SE program name
  forward     INTEGER NOT NULL DEFAULT 0,      -- 1 = relay registrations to the draft board
  closed      INTEGER NOT NULL DEFAULT 0,      -- 1 = an admin has shut registration
  notes       TEXT NOT NULL DEFAULT ''
);

-- Every kid we expect or have: last season's returners (returner=1) and new
-- registrants. Only Registered and still-pending returners take a seat.
CREATE TABLE IF NOT EXISTS players (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  name_key           TEXT NOT NULL,
  birthdate          TEXT,
  returner          INTEGER NOT NULL DEFAULT 0,
  prior_division     TEXT NOT NULL DEFAULT '',   -- last season's division/team, as uploaded
  division_id        TEXT REFERENCES divisions(id) ON DELETE SET NULL,
  division_locked    INTEGER NOT NULL DEFAULT 0, -- 1 = an admin placed them; registrations never move them
  status             TEXT NOT NULL,
  status_locked      INTEGER NOT NULL DEFAULT 0,
  notes              TEXT NOT NULL DEFAULT '',
  se_program         TEXT,                       -- program name from their SE registration
  se_profile_id      TEXT,
  se_registration_id TEXT,
  registered_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS players_name_key ON players(name_key);
CREATE UNIQUE INDEX IF NOT EXISTS players_se_profile ON players(se_profile_id) WHERE se_profile_id IS NOT NULL;

-- Every SportsEngine delivery (and CSV import row), stored before processing
-- so a mapping fix can be replayed against what actually arrived.
CREATE TABLE IF NOT EXISTS registrations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at        TEXT NOT NULL DEFAULT (datetime('now')),
  source             TEXT NOT NULL,    -- 'webhook' | 'csv' | 'manual'
  event_id           TEXT,
  event_type         TEXT,
  verified           INTEGER NOT NULL DEFAULT 0,
  raw                TEXT NOT NULL,    -- exactly the bytes received, so a relay keeps the signature valid
  signature          TEXT,
  batched            INTEGER NOT NULL DEFAULT 0,
  first_name         TEXT,
  last_name          TEXT,
  birthdate          TEXT,
  reg_year           INTEGER,
  program            TEXT,
  se_profile_id      TEXT,
  se_registration_id TEXT,
  outcome            TEXT NOT NULL DEFAULT 'pending',  -- placed|returner|no_division|wrong_year|ambiguous|withdrawn|ignored|error|pending
  player_id          TEXT REFERENCES players(id) ON DELETE SET NULL,
  division_id        TEXT REFERENCES divisions(id) ON DELETE SET NULL,
  note               TEXT NOT NULL DEFAULT '',
  forwarded          TEXT                              -- null | 'ok' | 'failed: ...'
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_event ON registrations(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  player_id TEXT,
  detail    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS admins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`)

const DEFAULT_SETTINGS: Record<string, unknown> = {
  season: '2027',
  registrationYear: 2027,
  ageCutoff: '04-30',   // league age = age on this MM-DD of the season year
  warnAt: 4,            // open seats at or below this = "closing soon"
}
const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, JSON.stringify(v))
