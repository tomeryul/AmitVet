'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireVet } = require('../auth');

const router = express.Router();

const TYPES = ['checkup', 'vaccination', 'surgery', 'dental', 'grooming', 'emergency', 'follow_up', 'other'];
const STATUSES = ['requested', 'confirmed', 'completed', 'cancelled'];

const SELECT_FULL = `
  SELECT a.*, u.name AS client_name, u.phone AS client_phone, p.name AS pet_name, p.species AS pet_species
  FROM appointments a
  JOIN users u ON u.id = a.client_id
  LEFT JOIN pets p ON p.id = a.pet_id
`;

// List: vet sees everything (optionally filtered by status); client sees their own.
router.get('/', requireAuth, (req, res) => {
  let rows;
  if (req.user.role === 'vet') {
    if (req.query.status && STATUSES.includes(req.query.status)) {
      rows = db.prepare(`${SELECT_FULL} WHERE a.status = ? ORDER BY a.scheduled_at ASC`).all(req.query.status);
    } else {
      rows = db.prepare(`${SELECT_FULL} ORDER BY a.scheduled_at ASC`).all();
    }
  } else {
    rows = db.prepare(`${SELECT_FULL} WHERE a.client_id = ? ORDER BY a.scheduled_at DESC`).all(req.user.id);
  }
  res.json({ appointments: rows });
});

// Client (or vet) requests/creates an appointment.
router.post('/', requireAuth, (req, res) => {
  const { pet_id, type, scheduled_at, duration_min, reason, client_id } = req.body || {};
  if (!scheduled_at) {
    return res.status(400).json({ error: 'נא לבחור תאריך ושעה לפגישה' });
  }
  const clientId = req.user.role === 'vet' && client_id ? client_id : req.user.id;

  if (pet_id) {
    const pet = db.prepare('SELECT owner_id FROM pets WHERE id = ?').get(pet_id);
    if (!pet) return res.status(400).json({ error: 'חיה לא נמצאה' });
    if (req.user.role !== 'vet' && pet.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'אין הרשאה לחיה זו' });
    }
  }

  // Vet-created appointments are confirmed immediately; client requests await approval.
  const status = req.user.role === 'vet' ? 'confirmed' : 'requested';
  const info = db
    .prepare(`INSERT INTO appointments (client_id, pet_id, type, scheduled_at, duration_min, reason, status)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(clientId, pet_id || null, TYPES.includes(type) ? type : 'checkup',
         scheduled_at, duration_min ? Number(duration_min) : 30, reason || null, status);
  res.status(201).json({ appointment: db.prepare(`${SELECT_FULL} WHERE a.id = ?`).get(info.lastInsertRowid) });
});

// Vet updates status / notes / reschedules.
router.patch('/:id', requireAuth, (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'פגישה לא נמצאה' });

  const isOwner = appt.client_id === req.user.id;
  const isVet = req.user.role === 'vet';
  if (!isVet && !isOwner) return res.status(403).json({ error: 'אין הרשאה' });

  const { status, scheduled_at, vet_notes, type, reason } = req.body || {};

  // Clients are only allowed to cancel their own pending/confirmed appointments.
  if (!isVet) {
    if (status && status !== 'cancelled') {
      return res.status(403).json({ error: 'ניתן לבטל פגישה בלבד' });
    }
    db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run('cancelled', appt.id);
    return res.json({ appointment: db.prepare(`${SELECT_FULL} WHERE a.id = ?`).get(appt.id) });
  }

  db.prepare(`UPDATE appointments SET status=?, scheduled_at=?, vet_notes=?, type=?, reason=? WHERE id=?`)
    .run(STATUSES.includes(status) ? status : appt.status,
         scheduled_at || appt.scheduled_at,
         vet_notes ?? appt.vet_notes,
         TYPES.includes(type) ? type : appt.type,
         reason ?? appt.reason,
         appt.id);
  res.json({ appointment: db.prepare(`${SELECT_FULL} WHERE a.id = ?`).get(appt.id) });
});

router.delete('/:id', requireVet, (req, res) => {
  const appt = db.prepare('SELECT id FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'פגישה לא נמצאה' });
  db.prepare('DELETE FROM appointments WHERE id = ?').run(appt.id);
  res.json({ ok: true });
});

module.exports = router;
