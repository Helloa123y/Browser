const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// serve static files from ./public (place your index.html there)
app.use(express.static(path.join(__dirname, 'public')));

// API: request a new fake captcha session id
app.get('/api/request-captcha', (req, res) => {
  // generate random 9-digit numeric string (leading zeros allowed)
  // using crypto.randomInt for good randomness
  const n = crypto.randomInt(0, 1_000_000_000); // 0 .. 999,999,999
  const sessionId = String(n).padStart(9, '0');
  res.json({ sessionId });
});

// optional: health check
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
