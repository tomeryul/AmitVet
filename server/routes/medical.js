'use strict';

const express = require('express');
const { db } = require('../db');
const { requireVet } = require('../auth');

const router = express.Router();

// Medical records and vaccinations are written by the vet only.
// (Clients can read them via GET /api/pets/:id.)

router.post('/records', requireVet, (req, res) => {
  const { pet_id, visit_date, diagnosis, treatment, notes } = req.body || {};
  if (!pet_id) return res.status(400).json({ error: 'נא לבחור חיה' });
  if (!db.prepare('SELECT id FROM pets WHERE id = ?').get(pet_id)) {
    return res.status(404).json({ error: 'חיה לא נמצאה' });
  }
  const info = db
    .prepare(`INSERT INTO medical_records (pet_id, vet_id, visit_date, diagnosis, treatment, notes)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(pet_id, req.user.id, visit_date || new Date().toISOString().slice(0, 10),
         diagnosis || null, treatment || null, notes || null);
  res.status(201).json({ record: db.prepare('SELECT * FROM medical_records WHERE id = ?').get(info.lastInsertRowid) });
});

router.delete('/records/:id', requireVet, (req, res) => {
  db.prepare('DELETE FROM medical_records WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/vaccinations', requireVet, (req, res) => {
  const { pet_id, vaccine_name, date_given, next_due, notes } = req.body || {};
  if (!pet_id || !vaccine_name) return res.status(400).json({ error: 'נא לבחור חיה ושם חיסון' });
  if (!db.prepare('SELECT id FROM pets WHERE id = ?').get(pet_id)) {
    return res.status(404).json({ error: 'חיה לא נמצאה' });
  }
  const info = db
    .prepare(`INSERT INTO vaccinations (pet_id, vaccine_name, date_given, next_due, notes)
              VALUES (?, ?, ?, ?, ?)`)
    .run(pet_id, vaccine_name.trim(), date_given || new Date().toISOString().slice(0, 10),
         next_due || null, notes || null);
  res.status(201).json({ vaccination: db.prepare('SELECT * FROM vaccinations WHERE id = ?').get(info.lastInsertRowid) });
});

router.delete('/vaccinations/:id', requireVet, (req, res) => {
  db.prepare('DELETE FROM vaccinations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
