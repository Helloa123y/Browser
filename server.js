const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

// 🔹 Statische Dateien
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// === Datenstrukturen ===
const userSessions = new Map();
const availableCaptchas = [];
const assignedCaptchas = new Map();
const queue = [];
const queueMap = new Map();
const QUEUE_TIMEOUT = 2 * 60 * 1000;

// === Middleware für Client-ID via Cookie ===
app.use((req, res, next) => {
    let clientId = req.cookies.clientId;
    if (!clientId) {
        clientId = crypto.randomUUID();
        res.cookie('clientId', clientId, { maxAge: 7 * 24 * 60 * 60 * 1000 });
    }
    req.clientId = clientId;
    next();
});

// === Queue-System ===
function syncQueueMap() {
    queueMap.clear();
    queue.forEach((user, idx) => queueMap.set(user.clientId, idx));
}

function cleanQueue() {
    const now = Date.now();
    for (let i = queue.length - 1; i >= 0; i--) {
        if (now - queue[i].timestamp > QUEUE_TIMEOUT) {
            const clientId = queue[i].clientId;
            queue.splice(i, 1);
            queueMap.delete(clientId);
            userSessions.delete(clientId);
            console.log(`[QUEUE] ${clientId} wegen Timeout entfernt`);
        }
    }
    syncQueueMap();
}

function getQueuePosition(clientId) {
    const index = queueMap.get(clientId);
    return index !== undefined ? index + 1 : -1;
}

function addToQueue(clientId) {
    if (queueMap.has(clientId)) return getQueuePosition(clientId);
    cleanQueue();
    queue.push({ clientId, timestamp: Date.now() });
    syncQueueMap();
    console.log(`[QUEUE] ${clientId} in Queue (Pos: ${queue.length})`);
    return queue.length;
}

// === Captchas laden ===
async function loadCaptchas() {
    try {
        const response = await axios.post("http://91.98.162.218/download", {
            channelId: 2,
            filename: "Captchas"
        }, { timeout: 15000 });

        const captchas = response.data.content || [];
        let newCount = 0;

        captchas.forEach(c => {
            if (!c.id || !c.url) return;

            // URL und Instruction trennen
            if (c.url.includes("@")) {
                const [urlPart, instructionPart] = c.url.split("@");
                c.url = urlPart.trim();
                c.instruction = instructionPart?.trim() || "Solve the captcha as described.";
            } else if (!c.instruction) {
                c.instruction = "Solve the captcha as described.";
            }

            if (!assignedCaptchas.has(c.id) && !availableCaptchas.find(x => x.id === c.id)) {
                availableCaptchas.push(c);
                newCount++;
            }
        });

        console.log(`[LOAD] ${newCount} neue Captchas geladen. Verfügbar: ${availableCaptchas.length}`);
    } catch (err) {
        console.error('[ERROR] Fehler beim Laden:', err.message);
    }
}

// === Captcha auswählen ===
function pickBestCaptcha(captchas) {
    let minData = Infinity;
    let selected = null;
    captchas.forEach(c => {
        const count = countDataPoints(c);
        if (count < minData) {
            minData = count;
            selected = c;
        }
    });
    return selected;
}

// === Hilfsfunktion: Datenpunkte zählen ===
function countDataPoints(captcha) {
    let total = 0;
    for (let key in captcha.data) {
        const value = captcha.data[key];
        if (Array.isArray(value)) total += value.length;
        else if (typeof value === 'object' && value !== null)
            total += Object.keys(value).length;
    }
    return total;
}

// === API: Captcha anfordern ===
app.get('/api/request-captcha', async (req, res) => {
    const clientId = req.clientId;

    // Prüfen, ob Captcha bereits zugewiesen
    for (let [id, info] of assignedCaptchas.entries()) {
        if (info.clientId === clientId) {
            return res.json({
                success: true,
                sessionId: id,
                captchaUrl: info.captcha.url,
                instruction: info.captcha.instruction
            });
        }
    }

    // Kein Captcha frei → Queue
    if (availableCaptchas.length === 0) {
        const position = addToQueue(clientId);
        return res.json({ success: false, message: "In Warteschlange", position });
    }

    // Captcha auswählen
    const selected = pickBestCaptcha(availableCaptchas);
    if (!selected) return res.status(500).json({ success: false, message: "Keine Captchas gefunden." });

    availableCaptchas.splice(availableCaptchas.indexOf(selected), 1);
    assignedCaptchas.set(selected.id, { clientId, captcha: selected });

    userSessions.set(selected.id, {
        sessionId: selected.id,
        captchaUrl: selected.url,
        userAnswers: {},
        completed: false
    });

    res.json({
        success: true,
        sessionId: selected.id,
        captchaUrl: selected.url,
        instruction: selected.instruction
    });
});

// === Queue-Abfrage ===
app.get('/api/queue-position', (req, res) => {
    const pos = getQueuePosition(req.clientId);
    res.json({ success: true, position: pos, queueLength: queue.length });
});

// === API: Captcha absenden ===
app.post('/api/submit-captcha', async (req, res) => {
    try {
        const { sessionId, captchaNumber, userAnswer } = req.body;
        if (!sessionId || !captchaNumber || !userAnswer)
            return res.status(400).json({ success: false, message: "Fehlende Parameter" });

        const session = userSessions.get(sessionId);
        if (!session) return res.status(404).json({ success: false, message: "Session nicht gefunden" });

        session.userAnswers[captchaNumber] = userAnswer;
        const completedCount = Object.keys(session.userAnswers).length;

        const uploadResult = await sendToMainServer(session);
        console.log(`[UPLOAD] Antwort gesendet für ${sessionId}: ${completedCount}/10`);

        if (completedCount >= 10) {
            userSessions.delete(sessionId);
            assignedCaptchas.delete(sessionId);
            res.json({ success: true, message: "Alle Captchas abgeschlossen.", completed: true });
        } else {
            res.json({ success: true, message: "Antwort gespeichert.", progress: `${completedCount}/10` });
        }
    } catch (err) {
        console.error("[ERROR] Beim Absenden:", err.message);
        res.status(500).json({ success: false, message: "Fehler beim Absenden.", error: err.message });
    }
});

// === Upload zum Hauptserver ===
async function sendToMainServer(session) {
    const { sessionId, captchaUrl, userAnswers } = session;
    const bodyData = {};
    for (let i = 1; i <= 10; i++) bodyData[i] = userAnswers[i];

    const payload = {
        channelId: 4,
        message: { sessionId, id: sessionId, url: captchaUrl, body: bodyData },
        FileName: "Captchas"
    };

    const response = await axios.post("http://91.98.162.218/upload", payload, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Content-Type": "application/json" }
    });

    return { status: response.status, data: response.data };
}

// === Health Check ===
app.get('/health', (req, res) => res.json({ ok: true }));

// === Server starten ===
app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
    setInterval(loadCaptchas, 30 * 1000);
    setInterval(cleanQueue, 15 * 1000);
    loadCaptchas();
});
