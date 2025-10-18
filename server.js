const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1️⃣ Statische Dateien ausliefern (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Hilfsfunktion: Zähle Datenpunkte in einem Captcha
function countDataPoints(captcha) {
    let totalCount = 0;
    for (let key in captcha.data) {
        const value = captcha.data[key];
        if (Array.isArray(value)) {
            totalCount += value.length;
        } else if (typeof value === 'object' && value !== null) {
            // Für Objekte wie {1, 2} - zähle die Anzahl der Eigenschaften
            totalCount += Object.keys(value).length;
        }
    }
    return totalCount;
}

// Hilfsfunktion: Bestimme welche Hälfte mehr Daten hat
function getHalfWithMoreData(captcha) {
    let firstHalfCount = 0;
    let secondHalfCount = 0;
    
    for (let key in captcha.data) {
        const keyNum = parseInt(key);
        const value = captcha.data[key];
        let count = 0;
        
        if (Array.isArray(value)) {
            count = value.length;
        } else if (typeof value === 'object' && value !== null) {
            count = Object.keys(value).length;
        }
        
        if (keyNum >= 1 && keyNum <= 5) {
            firstHalfCount += count;
        } else if (keyNum >= 6 && keyNum <= 10) {
            secondHalfCount += count;
        }
    }
    
    return {
        firstHalfCount,
        secondHalfCount,
        firstHalfHasMore: firstHalfCount > secondHalfCount
    };
}

// 2️⃣ API: request a new fake captcha session id
app.get('/api/request-captcha', async (req, res) => {
  try {
    console.log(`[INFO] Neue Captcha-Session angefordert.`);

    // POST an den externen Server
    const response = await axios.post(
      "http://91.98.162.218/download",
      {
        channelId: 2,   // Channel 2 → Captchas
        filename: "Captchas" // kann beliebig sein, wenn der Server es erwartet
      },
      { timeout: 15000 }
    );

    console.log(`[DEBUG] Remote Captcha-Server antwortete mit Status ${response.status}`);

    // Captcha mit den wenigsten Daten auswählen
    const captchas = response.data.content || [];
    let selectedCaptcha = null;
    let minDataCount = Infinity;

    captchas.forEach(captcha => {
        const dataCount = countDataPoints(captcha);
        console.log(`[DEBUG] Captcha ${captcha.id} hat ${dataCount} Datenpunkte`);
        
        if (dataCount < minDataCount) {
            minDataCount = dataCount;
            selectedCaptcha = captcha;
        }
    });

    if (!selectedCaptcha) {
        throw new Error('Keine gültigen Captchas gefunden');
    }

    console.log(`[INFO] Captcha ${selectedCaptcha.id} ausgewählt mit ${minDataCount} Datenpunkten`);

    // Bestimme welche Hälfte mehr Daten hat
    const halfAnalysis = getHalfWithMoreData(selectedCaptcha);
    console.log(`[DEBUG] Hälften-Analyse: 1-5: ${halfAnalysis.firstHalfCount}, 6-10: ${halfAnalysis.secondHalfCount}`);

    // Erfolgreich → an Client zurückgeben
    res.json({
      sessionId: selectedCaptcha.id, // Verwende die Captcha-ID als Session-ID
      success: true,
      message: "Captchas erfolgreich geladen.",
      captchaUrl: selectedCaptcha.url, // Sende die URL des Captchas
      firstHalfHasMore: halfAnalysis.firstHalfHasMore, // true wenn 1-5 mehr Daten hat, sonst false
      dataAnalysis: {
        firstHalfCount: halfAnalysis.firstHalfCount,
        secondHalfCount: halfAnalysis.secondHalfCount,
        totalCount: minDataCount
      }
    });

  } catch (err) {
    console.error("[ERROR] Fehler beim Captcha-Download:", err.message);

    // Detailierten Fehler an den Client
    res.status(500).json({
      success: false,
      message: "Fehler beim Laden der Captchas.",
      error: err.message,
      details: err.response?.data || null
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
