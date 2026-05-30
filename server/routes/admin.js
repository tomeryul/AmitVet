'use strict';

const express = require('express');
const { db } = require('../db');
const { requireVet } = require('../auth');

const router = express.Router();

// Client list for the vet (with pet counts).
router.get('/clients', requireVet, (req, res) => {
  const rows = db
    .prepare(`SELECT u.id, u.name, u.email, u.phone, u.created_at,
                     (SELECT COUNT(*) FROM pets p WHERE p.owner_id = u.id) AS pet_count
              FROM users u WHERE u.role = 'client' ORDER BY u.name ASC`)
    .all();
  res.json({ clients: rows });
});

// Dashboard summary for the vet.
router.get('/dashboard', requireVet, (req, res) => {
  const pendingAppointments = db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'requested'").get().n;
  const openInquiries = db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE status != 'resolved'").get().n;
  const totalClients = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'client'").get().n;
  const totalPets = db.prepare('SELECT COUNT(*) AS n FROM pets').get().n;

  const todayAppointments = db
    .prepare(`SELECT a.*, u.name AS client_name, p.name AS pet_name
              FROM appointments a JOIN users u ON u.id = a.client_id
              LEFT JOIN pets p ON p.id = a.pet_id
              WHERE date(a.scheduled_at) = date('now') AND a.status IN ('confirmed','requested')
              ORDER BY a.scheduled_at ASC`)
    .all();

  // Vaccinations coming due within the next 30 days.
  const upcomingVaccinations = db
    .prepare(`SELECT v.*, p.name AS pet_name, u.name AS owner_name
              FROM vaccinations v JOIN pets p ON p.id = v.pet_id JOIN users u ON u.id = p.owner_id
              WHERE v.next_due IS NOT NULL
                AND date(v.next_due) BETWEEN date('now') AND date('now', '+30 day')
              ORDER BY v.next_due ASC`)
    .all();

  res.json({
    stats: { pendingAppointments, openInquiries, totalClients, totalPets },
    todayAppointments,
    upcomingVaccinations,
  });
});

module.exports = router;
