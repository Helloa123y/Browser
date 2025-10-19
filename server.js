const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1️⃣ Statische Dateien ausliefern (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// Session-Speicher für Captcha-Lösungen
const userSessions = new Map();

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
    
    console.log(`[DEBUG] Analysiere Captcha Daten:`, JSON.stringify(captcha.data, null, 2));
    
    for (let key in captcha.data) {
        const keyNum = parseInt(key);
        const value = captcha.data[key];
        
        let count = 0;
        if (Array.isArray(value)) {
            count = value.length;
            console.log(`[DEBUG] Key ${key}: Array mit ${count} Elementen`);
        } else if (typeof value === 'object' && value !== null) {
            count = Object.keys(value).length;
            console.log(`[DEBUG] Key ${key}: Objekt mit ${count} Eigenschaften`);
        } else if (value !== null && value !== undefined && value !== "") {
            count = 1;
            console.log(`[DEBUG] Key ${key}: Einzelwert "${value}"`);
        } else {
            console.log(`[DEBUG] Key ${key}: Leerer Wert`);
        }
        
        if (keyNum >= 1 && keyNum <= 5) {
            firstHalfCount += count;
            console.log(`[DEBUG] → Zur ersten Hälfte hinzugefügt: ${count}`);
        } else if (keyNum >= 6 && keyNum <= 10) {
            secondHalfCount += count;
            console.log(`[DEBUG] → Zur zweiten Hälfte hinzugefügt: ${count}`);
        } else {
            console.log(`[DEBUG] → Key ${key} außerhalb des Bereichs 1-10`);
        }
    }
    
    console.log(`[HALF_ANALYSIS] Ergebnis: 1-5: ${firstHalfCount}, 6-10: ${secondHalfCount}, firstHalfHasMore: ${firstHalfCount > secondHalfCount}`);
    
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

    // Session für Benutzerantworten initialisieren
    userSessions.set(selectedCaptcha.id, {
        sessionId: selectedCaptcha.id,
        captchaUrl: selectedCaptcha.url,
        firstHalfHasMore: halfAnalysis.firstHalfHasMore,
        userAnswers: {}, // {1: "1", 2: "2", 3: "3", 4: "2", 5: "1"}
        completed: false
    });

    // Erfolgreich → an Client zurückgeben
    res.json({
      sessionId: selectedCaptcha.id, // Verwende die Captcha-ID als Session-ID
      success: true,
      message: "Captchas erfolgreich geladen.",
      captchaUrl: selectedCaptcha.url.split('@')[0], // Nur die URL
      instruction: selectedCaptcha.url.split('@')[1], // Nur die Instruction
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

// 3️⃣ API: Captcha-Antwort speichern
app.post('/api/submit-captcha', async (req, res) => {
  try {
    const { sessionId, captchaNumber, userAnswer } = req.body;

    if (!sessionId || !captchaNumber || !userAnswer) {
      return res.status(400).json({
        success: false,
        message: "SessionId, CaptchaNumber und UserAnswer sind erforderlich."
      });
    }

    console.log(`[INFO] Captcha-Antwort für Session ${sessionId}, Captcha ${captchaNumber}: ${userAnswer}`);

    // Session laden
    const session = userSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session nicht gefunden."
      });
    }

    // Antwort speichern
    session.userAnswers[captchaNumber] = userAnswer;

    // Prüfen ob alle 5 Captchas abgeschlossen sind
    const completedCaptchas = Object.keys(session.userAnswers).length;
    console.log(`[DEBUG] Session ${sessionId}: ${completedCaptchas}/5 Captchas abgeschlossen`);

    if (completedCaptchas === 5) {
      session.completed = true;
      console.log(`[INFO] Alle Captchas für Session ${sessionId} abgeschlossen!`);

      // Daten an Hauptserver senden
      try {
        const uploadResult = await sendToMainServer(session);
        console.log(`[SUCCESS] Daten erfolgreich an Hauptserver gesendet:`, uploadResult);

        // Session nach erfolgreichem Upload löschen
        userSessions.delete(sessionId);

        return res.json({
          success: true,
          message: "Alle Captchas abgeschlossen und Daten gesendet!",
          uploadResult: uploadResult,
          completed: true
        });

      } catch (uploadError) {
        console.error(`[ERROR] Fehler beim Senden an Hauptserver:`, uploadError);
        return res.status(500).json({
          success: false,
          message: "Captchas abgeschlossen, aber Fehler beim Senden an Hauptserver.",
          error: uploadError.message,
          completed: true
        });
      }
    }

    // Nur Antwort gespeichert, noch nicht alle Captchas fertig
    res.json({
      success: true,
      message: "Antwort gespeichert.",
      completed: false,
      progress: `${completedCaptchas}/5`
    });

  } catch (err) {
    console.error("[ERROR] Fehler beim Speichern der Captcha-Antwort:", err.message);
    res.status(500).json({
      success: false,
      message: "Fehler beim Speichern der Antwort.",
      error: err.message
    });
  }
});

// 4️⃣ Funktion: Daten an Hauptserver senden
// 4️⃣ Funktion: Daten an Hauptserver senden
async function sendToMainServer(session) {
  const { sessionId, captchaUrl, firstHalfHasMore, userAnswers } = session;

  // Body-Daten für den Upload vorbereiten
  const bodyData = {};
  
  // Je nachdem welche Hälfte mehr Daten hat, die Antworten zuordnen
  if (firstHalfHasMore) {
    // Erste Hälfte (1-5) bekommt die echten Antworten
    for (let i = 1; i <= 5; i++) {
      bodyData[i] = userAnswers[i] || "1"; // Nur den Wert, z.B. "3"
    }
    // Zweite Hälfte (6-10) bekommt leere Daten
    for (let i = 6; i <= 10; i++) {
      bodyData[i] = {};
    }
  } else {
    // Zweite Hälfte (6-10) bekommt die echten Antworten
    // Erste Hälfte (1-5) bekommt leere Daten
    for (let i = 1; i <= 5; i++) {
      bodyData[i] = {};
    }
    for (let i = 6; i <= 10; i++) {
      const originalIndex = i - 5; // Mappe 6→1, 7→2, etc.
      bodyData[i] = userAnswers[originalIndex] || "1"; // Nur den Wert
    }
  }

  // Payload für Hauptserver
  const payload = {
    channelId: 3,
    message: {
      sessionId: sessionId,
      erstehälfte: firstHalfHasMore, // true = erste Hälfte, false = zweite Hälfte
      id: sessionId, // gametoken
      url: captchaUrl,
      body: bodyData
    },
    FileName: "Captchas"
  };

  console.log(`[UPLOAD] Sende Daten an Hauptserver:`, {
    sessionId: sessionId,
    erstehälfte: firstHalfHasMore,
    answerCount: Object.keys(userAnswers).length,
    bodyData: bodyData
  });

  // Upload an Hauptserver
  const response = await axios.post(
    "http://91.98.162.218/upload",
    payload,
    {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    }
  );

  return {
    status: response.status,
    data: response.data
  };
}

// 5️⃣ Health Check (optional)
app.get('/health', (req, res) => res.json({ ok: true }));

// 7️⃣ Alle anderen Requests → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 8️⃣ Server starten
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
