'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'amitvet.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      phone         TEXT,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','vet')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      species     TEXT NOT NULL,
      breed       TEXT,
      sex         TEXT CHECK (sex IN ('male','female','unknown')) DEFAULT 'unknown',
      birthdate   TEXT,
      weight_kg   REAL,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pet_id       INTEGER REFERENCES pets(id) ON DELETE SET NULL,
      type         TEXT NOT NULL DEFAULT 'checkup',
      scheduled_at TEXT NOT NULL,
      duration_min INTEGER NOT NULL DEFAULT 30,
      reason       TEXT,
      status       TEXT NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested','confirmed','completed','cancelled')),
      vet_notes    TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inquiries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pet_id      INTEGER REFERENCES pets(id) ON DELETE SET NULL,
      subject     TEXT NOT NULL,
      priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id  INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
      sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS medical_records (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id      INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
      vet_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      visit_date  TEXT NOT NULL DEFAULT (date('now')),
      diagnosis   TEXT,
      treatment   TEXT,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vaccinations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id        INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
      vaccine_name  TEXT NOT NULL,
      date_given    TEXT NOT NULL DEFAULT (date('now')),
      next_due      TEXT,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pets_owner       ON pets(owner_id);
    CREATE INDEX IF NOT EXISTS idx_appt_client      ON appointments(client_id);
    CREATE INDEX IF NOT EXISTS idx_appt_status      ON appointments(status);
    CREATE INDEX IF NOT EXISTS idx_inq_client       ON inquiries(client_id);
    CREATE INDEX IF NOT EXISTS idx_msg_inquiry      ON messages(inquiry_id);
    CREATE INDEX IF NOT EXISTS idx_med_pet          ON medical_records(pet_id);
    CREATE INDEX IF NOT EXISTS idx_vac_pet          ON vaccinations(pet_id);
  `);
}

// ---------------------------------------------------------------------------
// Seed - creates a default vet account and demo data on first run
// ---------------------------------------------------------------------------
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) {
    return; // already seeded
  }

  const insertUser = db.prepare(
    'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  );

  const vetHash = bcrypt.hashSync('admin1234', 10);
  const vet = insertUser.run('ד"ר עמית - וטרינר ראשי', 'admin@amitvet.local', '03-0000000', vetHash, 'vet');

  const clientHash = bcrypt.hashSync('client1234', 10);
  const client = insertUser.run('דנה כהן', 'dana@example.com', '050-1234567', clientHash, 'client');

  const insertPet = db.prepare(
    'INSERT INTO pets (owner_id, name, species, breed, sex, birthdate, weight_kg, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const rex = insertPet.run(client.lastInsertRowid, 'רקסי', 'כלב', 'לברדור', 'male', '2021-04-10', 28.5, 'אנרגטי, אוהב לרוץ');
  insertPet.run(client.lastInsertRowid, 'מיצי', 'חתול', 'חתול בית', 'female', '2022-09-01', 4.2, 'ביישנית');

  db.prepare(
    'INSERT INTO appointments (client_id, pet_id, type, scheduled_at, reason, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(client.lastInsertRowid, rex.lastInsertRowid, 'vaccination', futureDateTime(2, 10), 'חיסון שנתי', 'requested');

  const inq = db.prepare(
    'INSERT INTO inquiries (client_id, pet_id, subject, priority, status) VALUES (?, ?, ?, ?, ?)'
  ).run(client.lastInsertRowid, rex.lastInsertRowid, 'רקסי מגרד את האוזן הרבה', 'normal', 'open');
  db.prepare('INSERT INTO messages (inquiry_id, sender_id, body) VALUES (?, ?, ?)').run(
    inq.lastInsertRowid, client.lastInsertRowid,
    'שלום דוקטור, בימים האחרונים רקסי מגרד את האוזן הימנית הרבה ומנער את הראש. האם כדאי להגיע לבדיקה?'
  );

  db.prepare(
    'INSERT INTO vaccinations (pet_id, vaccine_name, date_given, next_due, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(rex.lastInsertRowid, 'כלבת', '2025-05-15', '2026-05-15', 'חיסון שנתי חובה');

  console.log('✓ נתוני דמו נוצרו. וטרינר: admin@amitvet.local / admin1234 | לקוח: dana@example.com / client1234');
}

function futureDateTime(daysAhead, hour) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  // store as 'YYYY-MM-DD HH:MM'
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

migrate();
seed();

module.exports = { db };

// allow `node server/db.js --seed` for an explicit re-seed run
if (require.main === module && process.argv.includes('--seed')) {
  console.log('Database initialised at', DB_PATH);
}
