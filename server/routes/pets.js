'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// Vet sees all pets; client sees only their own.
function ownsPetOr403(req, petId) {
  const pet = db.prepare('SELECT * FROM pets WHERE id = ?').get(petId);
  if (!pet) return { error: 404 };
  if (req.user.role !== 'vet' && pet.owner_id !== req.user.id) return { error: 403 };
  return { pet };
}

router.get('/', requireAuth, (req, res) => {
  let rows;
  if (req.user.role === 'vet') {
    rows = db
      .prepare(`SELECT p.*, u.name AS owner_name, u.phone AS owner_phone
                FROM pets p JOIN users u ON u.id = p.owner_id
                ORDER BY p.created_at DESC`)
      .all();
  } else {
    rows = db.prepare('SELECT * FROM pets WHERE owner_id = ? ORDER BY created_at DESC').all(req.user.id);
  }
  res.json({ pets: rows });
});

router.get('/:id', requireAuth, (req, res) => {
  const { pet, error } = ownsPetOr403(req, req.params.id);
  if (error) return res.status(error).json({ error: error === 404 ? 'חיה לא נמצאה' : 'אין הרשאה' });
  const vaccinations = db.prepare('SELECT * FROM vaccinations WHERE pet_id = ? ORDER BY date_given DESC').all(pet.id);
  const records = db
    .prepare(`SELECT m.*, u.name AS vet_name FROM medical_records m
              LEFT JOIN users u ON u.id = m.vet_id WHERE m.pet_id = ? ORDER BY m.visit_date DESC`)
    .all(pet.id);
  res.json({ pet, vaccinations, records });
});

router.post('/', requireAuth, (req, res) => {
  const { name, species, breed, sex, birthdate, weight_kg, notes, owner_id } = req.body || {};
  if (!name || !species) {
    return res.status(400).json({ error: 'שם החיה והמין (סוג) הם שדות חובה' });
  }
  // A vet may register a pet on behalf of a client; clients only for themselves.
  const ownerId = req.user.role === 'vet' && owner_id ? owner_id : req.user.id;
  const info = db
    .prepare(`INSERT INTO pets (owner_id, name, species, breed, sex, birthdate, weight_kg, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ownerId, name.trim(), species.trim(), breed || null,
         ['male', 'female', 'unknown'].includes(sex) ? sex : 'unknown',
         birthdate || null, weight_kg ? Number(weight_kg) : null, notes || null);
  res.status(201).json({ pet: db.prepare('SELECT * FROM pets WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/:id', requireAuth, (req, res) => {
  const { pet, error } = ownsPetOr403(req, req.params.id);
  if (error) return res.status(error).json({ error: error === 404 ? 'חיה לא נמצאה' : 'אין הרשאה' });
  const { name, species, breed, sex, birthdate, weight_kg, notes } = req.body || {};
  db.prepare(`UPDATE pets SET name=?, species=?, breed=?, sex=?, birthdate=?, weight_kg=?, notes=? WHERE id=?`)
    .run(name ?? pet.name, species ?? pet.species, breed ?? pet.breed,
         ['male', 'female', 'unknown'].includes(sex) ? sex : pet.sex,
         birthdate ?? pet.birthdate, weight_kg != null ? Number(weight_kg) : pet.weight_kg,
         notes ?? pet.notes, pet.id);
  res.json({ pet: db.prepare('SELECT * FROM pets WHERE id = ?').get(pet.id) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const { pet, error } = ownsPetOr403(req, req.params.id);
  if (error) return res.status(error).json({ error: error === 404 ? 'חיה לא נמצאה' : 'אין הרשאה' });
  db.prepare('DELETE FROM pets WHERE id = ?').run(pet.id);
  res.json({ ok: true });
});

module.exports = router;
