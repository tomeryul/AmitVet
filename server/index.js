'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { attachUser } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/pets', require('./routes/pets'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/inquiries', require('./routes/inquiries'));
app.use('/api/medical', require('./routes/medical'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'AmitVet' }));

// Static frontend
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// SPA fallback for non-API routes
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// JSON error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'שגיאת שרת פנימית' });
});

app.listen(PORT, () => {
  console.log(`\n🐾 AmitVet פועל בכתובת http://localhost:${PORT}\n`);
});
