const express = require('express');
const axios = require('axios');
const app = express();
const path = require('path');
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(express.json());

// --- Statische Dateien ausliefern ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Datenstrukturen ---
const availableCaptchas = []; // Captchas die noch vergeben werden können
const assignedCaptchas = new Map(); // sessionId -> { player, captcha, timestamp }
const queue = []; // { ip, timestamp }
const queueMap = new Map(); // ip -> index im queue-array

const QUEUE_TIMEOUT = 2 * 60 * 1000; // 2 Minuten

// --- Hilfsfunktion: IP aus Request ---
function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

// --- Neue Captchas laden ---
async function loadCaptchas() {
  try {
    const response = await axios.post("http://91.98.162.218/download", {
      channelId: 2,
      filename: "Captchas"
    }, { timeout: 15000 });

    const captchas = response.data.content || [];
    // Filtere die Captchas, die noch nicht vergeben wurden
    captchas.forEach(c => {
      if(!assignedCaptchas.has(c.id) && !availableCaptchas.find(x => x.id === c.id)) {
        availableCaptchas.push(c);
      }
    });

    console.log(`[INFO] Loaded ${availableCaptchas.length} captchas`);
  } catch(err) {
    console.error('[ERROR] Fehler beim Laden der Captchas:', err.message);
  }
}

// --- Queue-Aufräum-Funktion ---
function cleanQueue() {
  const now = Date.now();
  for(let i = queue.length - 1; i >= 0; i--) {
    if(now - queue[i].timestamp > QUEUE_TIMEOUT) {
      const ip = queue[i].ip;
      queue.splice(i, 1);
      queueMap.delete(ip);
      console.log(`[INFO] IP ${ip} aus der Queue entfernt wegen Timeout`);
    }
  }
}

// --- Queue-Position holen ---
function getQueuePosition(ip) {
  cleanQueue();
  return queue.findIndex(u => u.ip === ip) + 1; // +1 da Array-Index beginnt bei 0
}

// --- Neue Captcha-Session anfordern ---
app.get('/api/request-captcha', async (req, res) => {
  const ip = getClientIp(req);

  // Prüfen, ob Client schon ein Captcha hat
  for(let [sessionId, info] of assignedCaptchas.entries()) {
    if(info.ip === ip) {
      return res.json({
        success: true,
        message: "Du hast bereits ein Captcha.",
        captchaUrl: info.captcha.url,
        sessionId: sessionId
      });
    }
  }

  cleanQueue();

  if(availableCaptchas.length > 0 && queue.length === 0) {
    // Direkt ein Captcha vergeben
    const captcha = availableCaptchas.shift();
    const sessionId = captcha.id;
    assignedCaptchas.set(sessionId, { ip, captcha, timestamp: Date.now() });
    return res.json({
      success: true,
      sessionId,
      captchaUrl: captcha.url,
      message: "Captcha erhalten!"
    });
  } else {
    // In die Queue einreihen
    if(!queueMap.has(ip)) {
      queue.push({ ip, timestamp: Date.now() });
      queueMap.set(ip, queue.length - 1);
    }
    const position = getQueuePosition(ip);
    return res.json({
      success: false,
      message: "Du bist in der Warteschlange",
      position
    });
  }
});

// --- Submit Captcha ---
app.post('/api/submit-captcha', (req, res) => {
  const { sessionId, userAnswer } = req.body;
  const ip = getClientIp(req);

  if(!assignedCaptchas.has(sessionId)) {
    return res.status(400).json({ success:false, message: "Ungültige Session" });
  }

  const info = assignedCaptchas.get(sessionId);
  if(info.ip !== ip) {
    return res.status(403).json({ success:false, message: "Diese Session gehört nicht dir" });
  }

  console.log(`[INFO] Captcha ${sessionId} gelöst von IP ${ip}: ${userAnswer}`);
  
  assignedCaptchas.delete(sessionId);

  // Prüfen, ob jemand in der Queue wartet → nächste Person bekommt das Captcha
  if(queue.length > 0) {
    const nextUser = queue.shift();
    queueMap.delete(nextUser.ip);
    const nextCaptcha = availableCaptchas.shift();
    if(nextCaptcha) {
      assignedCaptchas.set(nextCaptcha.id, { ip: nextUser.ip, captcha: nextCaptcha, timestamp: Date.now() });
      console.log(`[INFO] IP ${nextUser.ip} bekommt Captcha ${nextCaptcha.id} aus der Queue`);
      // Hier könnte man über WebSocket oder Polling den Client informieren
    }
  }

  res.json({ success: true, message: "Captcha gespeichert" });
});

// --- Polling für Queue-Position (Client kann regelmäßig abfragen) ---
app.get('/api/queue-position', (req, res) => {
  const ip = getClientIp(req);
  const pos = getQueuePosition(ip);
  res.json({ success:true, position: pos });
});

// --- Server starten ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  setInterval(loadCaptchas, 30 * 1000); // alle 30 Sekunden neue Captchas laden
  setInterval(cleanQueue, 15 * 1000);   // alle 15 Sekunden Queue aufräumen
});
