const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1️⃣ Statische Dateien ausliefern (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// 2️⃣ API: request a new fake captcha session id
app.get('/api/request-captcha', async (req, res) => {
  try {
    // Zufällige Session-ID generieren
    const n = crypto.randomInt(0, 1_000_000_000); // 0 .. 999,999,999
    const sessionId = String(n).padStart(9, '0');

    console.log(`[INFO] Neue Captcha-Session ${sessionId} gestartet.`);

    // Anfrage an externen Server, um Captchas herunterzuladen
    const response = await axios.post("http://91.98.162.218/download", {
      params: { channelId: 2 }, // channelId=2 → Captchas laden
      timeout: 15000
    });
  
    console.log(`[DEBUG] Remote Captcha-Server antwortete mit Status ${response.status}`);

    // Rückgabe an Client
    res.json({
      sessionId,
      success: true,
      message: "Captchas erfolgreich geladen.",
      captchas: response.data
    });

  } catch (err) {
    console.error("[ERROR] Fehler beim Captcha-Download:", err.message);
    res.status(500).json({
      success: false,
      message: "Fehler beim Laden der Captchas.",
      error: err.message
    });
  }
});

// 3️⃣ Health Check (optional)
app.get('/health', (req, res) => res.json({ ok: true }));

// 4️⃣ Alle anderen Requests → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 5️⃣ Server starten
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
