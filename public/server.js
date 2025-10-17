// server.js
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 1️⃣ Statische Dateien ausliefern (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// 2️⃣ API: request a new fake captcha session id
app.get('/api/request-captcha', (req, res) => {
  const n = crypto.randomInt(0, 1_000_000_000); // 0 .. 999,999,999
  const sessionId = String(n).padStart(9, '0');
  res.json({ sessionId });
});

// 3️⃣ Health Check (optional)
app.get('/health', (req, res) => res.json({ ok: true }));

// 4️⃣ Alle anderen Requests → index.html (für SPA, optional)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 5️⃣ Server starten
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
