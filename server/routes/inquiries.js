'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved'];

const SELECT_FULL = `
  SELECT i.*, u.name AS client_name, p.name AS pet_name,
         (SELECT COUNT(*) FROM messages m WHERE m.inquiry_id = i.id) AS message_count
  FROM inquiries i
  JOIN users u ON u.id = i.client_id
  LEFT JOIN pets p ON p.id = i.pet_id
`;

function canAccess(req, inq) {
  return req.user.role === 'vet' || inq.client_id === req.user.id;
}

router.get('/', requireAuth, (req, res) => {
  let rows;
  if (req.user.role === 'vet') {
    if (req.query.status && STATUSES.includes(req.query.status)) {
      rows = db.prepare(`${SELECT_FULL} WHERE i.status = ? ORDER BY i.updated_at DESC`).all(req.query.status);
    } else {
      rows = db.prepare(`${SELECT_FULL} ORDER BY i.updated_at DESC`).all();
    }
  } else {
    rows = db.prepare(`${SELECT_FULL} WHERE i.client_id = ? ORDER BY i.updated_at DESC`).all(req.user.id);
  }
  res.json({ inquiries: rows });
});

router.get('/:id', requireAuth, (req, res) => {
  const inq = db.prepare(`${SELECT_FULL} WHERE i.id = ?`).get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'פנייה לא נמצאה' });
  if (!canAccess(req, inq)) return res.status(403).json({ error: 'אין הרשאה' });
  const messages = db
    .prepare(`SELECT m.*, u.name AS sender_name, u.role AS sender_role
              FROM messages m JOIN users u ON u.id = m.sender_id
              WHERE m.inquiry_id = ? ORDER BY m.created_at ASC`)
    .all(inq.id);
  res.json({ inquiry: inq, messages });
});

// Open a new inquiry. The opening text becomes the first message.
router.post('/', requireAuth, (req, res) => {
  const { subject, body, pet_id, priority, client_id } = req.body || {};
  if (!subject || !body) {
    return res.status(400).json({ error: 'נושא ותוכן ההודעה הם שדות חובה' });
  }
  const clientId = req.user.role === 'vet' && client_id ? client_id : req.user.id;
  const info = db
    .prepare('INSERT INTO inquiries (client_id, pet_id, subject, priority) VALUES (?, ?, ?, ?)')
    .run(clientId, pet_id || null, subject.trim(), PRIORITIES.includes(priority) ? priority : 'normal');
  db.prepare('INSERT INTO messages (inquiry_id, sender_id, body) VALUES (?, ?, ?)')
    .run(info.lastInsertRowid, req.user.id, body.trim());
  res.status(201).json({ inquiry: db.prepare(`${SELECT_FULL} WHERE i.id = ?`).get(info.lastInsertRowid) });
});

// Reply within a thread. A vet reply moves an "open" inquiry to "in_progress".
router.post('/:id/messages', requireAuth, (req, res) => {
  const inq = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'פנייה לא נמצאה' });
  if (!canAccess(req, inq)) return res.status(403).json({ error: 'אין הרשאה' });
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'לא ניתן לשלוח הודעה ריקה' });

  const info = db.prepare('INSERT INTO messages (inquiry_id, sender_id, body) VALUES (?, ?, ?)')
    .run(inq.id, req.user.id, body.trim());

  let newStatus = inq.status;
  if (req.user.role === 'vet' && inq.status === 'open') newStatus = 'in_progress';
  db.prepare("UPDATE inquiries SET updated_at = datetime('now'), status = ? WHERE id = ?").run(newStatus, inq.id);

  const message = db
    .prepare(`SELECT m.*, u.name AS sender_name, u.role AS sender_role
              FROM messages m JOIN users u ON u.id = m.sender_id
              WHERE m.id = ?`)
    .get(info.lastInsertRowid);
  res.status(201).json({ message });
});

// Vet (or owner) updates status / priority.
router.patch('/:id', requireAuth, (req, res) => {
  const inq = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'פנייה לא נמצאה' });
  if (!canAccess(req, inq)) return res.status(403).json({ error: 'אין הרשאה' });
  const { status, priority } = req.body || {};
  db.prepare("UPDATE inquiries SET status = ?, priority = ?, updated_at = datetime('now') WHERE id = ?")
    .run(STATUSES.includes(status) ? status : inq.status,
         req.user.role === 'vet' && PRIORITIES.includes(priority) ? priority : inq.priority,
         inq.id);
  res.json({ inquiry: db.prepare(`${SELECT_FULL} WHERE i.id = ?`).get(inq.id) });
});

module.exports = router;
