'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'שם, אימייל וסיסמה הם שדות חובה' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'כתובת האימייל כבר רשומה במערכת' });
  }

  const hash = bcrypt.hashSync(String(password), 10);
  // New self-registrations are always clients; vet accounts are created by seed/admin.
  const info = db
    .prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), email.toLowerCase(), phone || null, hash, 'client');

  const user = { id: info.lastInsertRowid, name: name.trim(), role: 'client' };
  setAuthCookie(res, signToken(user));
  res.status(201).json({ user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'נא להזין אימייל וסיסמה' });
  }
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
    return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
  }
  setAuthCookie(res, signToken(row));
  res.json({ user: { id: row.id, name: row.name, role: row.role } });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, name, email, phone, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'משתמש לא נמצא' });
  res.json({ user: row });
});

module.exports = router;
