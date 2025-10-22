const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser'); // ✅ Cookie Parser
const app = express();
const path = require('path');
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser()); // ✅ Cookie Support
app.use(express.static(path.join(__dirname, 'public')));

// --- Datenstrukturen ---
const availableCaptchas = [];
const assignedCaptchas = new Map();
const queue = [];
const queueMap = new Map();
const userSessions = new Map();

const QUEUE_TIMEOUT = 2 * 60 * 1000;

// --- Debug-Funktion ---
function debugQueue() {
    console.log('=== QUEUE DEBUG ===');
    console.log('Queue Array:', queue.map((user, idx) => `${idx + 1}. ${user.clientId}`));
    console.log('Queue Map:', Object.fromEntries(queueMap));
    console.log('Available Captchas:', availableCaptchas.length);
    console.log('Assigned Captchas:', Array.from(assignedCaptchas.entries()).map(([id, info]) => `${id} -> ${info.clientId}`));
    console.log('==================');
}

// --- Queue-Funktionen ---
function addToQueue(clientId) {
    if (queueMap.has(clientId)) return getQueuePosition(clientId);
    cleanQueue();

    const entry = { clientId, timestamp: Date.now() };
    queue.push(entry);
    syncQueueMap();

    userSessions.set(clientId, {
        lastRequest: Date.now(),
        inQueue: true,
        assignedSession: null
    });

    const position = queue.findIndex(u => u.clientId === clientId) + 1;
    console.log(`[QUEUE] ${clientId} hinzugefügt. Position: ${position}`);
    debugQueue();
    return position;
}

function removeFromQueue(clientId) {
    const index = queueMap.get(clientId);
    if (index !== undefined) {
        queue.splice(index, 1);
        syncQueueMap();
        queueMap.delete(clientId);

        const session = userSessions.get(clientId);
        if (session) session.inQueue = false;

        console.log(`[QUEUE] ${clientId} entfernt. Verbleibende in Queue: ${queue.length}`);
        debugQueue();
    }
}

function getQueuePosition(clientId) {
    const index = queueMap.get(clientId);
    return index !== undefined ? index + 1 : -1;
}

function syncQueueMap() {
    queueMap.clear();
    queue.forEach((user, idx) => queueMap.set(user.clientId, idx));
}

function cleanQueue() {
    const now = Date.now();
    let removed = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
        if (now - queue[i].timestamp > QUEUE_TIMEOUT) {
            const clientId = queue[i].clientId;
            queue.splice(i, 1);
            queueMap.delete(clientId);
            userSessions.delete(clientId);
            removed++;
            console.log(`[QUEUE] ${clientId} wegen Timeout entfernt`);
        }
    }
    if (removed > 0) syncQueueMap();
}

function assignCaptchaToFirstInQueue() {
    if (availableCaptchas.length === 0 || queue.length === 0) return false;

    const nextCaptcha = availableCaptchas.shift();
    const nextUser = queue[0];

    assignedCaptchas.set(nextCaptcha.id, {
        clientId: nextUser.clientId,
        captcha: nextCaptcha,
        timestamp: Date.now()
    });

    const session = userSessions.get(nextUser.clientId);
    if (session) {
        session.assignedSession = nextCaptcha.id;
        session.inQueue = false;
    }

    console.log(`[ASSIGN] ${nextUser.clientId} bekommt Captcha ${nextCaptcha.id}`);
    removeFromQueue(nextUser.clientId);
    return true;
}

// --- Captchas laden ---
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

            // 🔹 URL + Instruction aufsplitten
            if (c.url.includes("@")) {
                const [urlPart, instructionPart] = c.url.split("@");
                c.url = urlPart.trim();
                c.instruction = instructionPart?.trim() || "Solve the captcha as described.";
            } else if (!c.instruction) {
                c.instruction = "Solve the captcha as described.";
            }

            // 🔹 Nur neue hinzufügen
            if (!assignedCaptchas.has(c.id) && !availableCaptchas.find(x => x.id === c.id)) {
                availableCaptchas.push(c);
                newCount++;
            }
        });

        console.log(`[LOAD] ${newCount} neue Captchas geladen. Total verfügbar: ${availableCaptchas.length}`);
        if (availableCaptchas.length > 0) {
            console.log("[DEBUG] Beispiel-Captcha:", availableCaptchas[0]);
        }

        while (assignCaptchaToFirstInQueue()) {}
    } catch (err) {
        console.error('[ERROR] Fehler beim Laden:', err.message);
    }
}

// --- Middleware um clientId zu setzen ---
app.use((req, res, next) => {
    let clientId = req.cookies.clientId;
    if (!clientId) {
        clientId = crypto.randomUUID();
        res.cookie('clientId', clientId, { maxAge: 7 * 24 * 60 * 60 * 1000 }); // 7 Tage
    }
    req.clientId = clientId;
    next();
});

// --- API Endpoints ---
app.get('/api/request-captcha', (req, res) => {
    const clientId = req.clientId;
    console.log(`[REQUEST] Captcha-Anfrage von ${clientId}`);

    // Prüfen ob bereits Captcha zugewiesen
    for (let [sessionId, info] of assignedCaptchas.entries()) {
        if (info.clientId === clientId) {
            removeFromQueue(clientId);
            return res.json({
                success: true,
                sessionId,
                captchaUrl: info.captcha.url,
                instruction: info.captcha.instruction
            });
        }
    }

    // Prüfen ob bereits in Queue
    const pos = getQueuePosition(clientId);
    if (pos > 0) {
        return res.json({ success: false, message: "In Warteschlange", position: pos, queueLength: queue.length });
    }

    // Neu in Queue
    const position = addToQueue(clientId);

    // Direkt Captcha wenn verfügbar
    if (position === 1 && availableCaptchas.length > 0) {
        assignCaptchaToFirstInQueue();
        for (let [sessionId, info] of assignedCaptchas.entries()) {
            if (info.clientId === clientId) {
                return res.json({
                    success: true,
                    sessionId,
                    captchaUrl: info.captcha.url,
                    instruction: info.captcha.instruction
                });
            }
        }
    }

    res.json({ success: false, message: "In Warteschlange", position, queueLength: queue.length });
});

app.get('/api/queue-position', (req, res) => {
    const pos = getQueuePosition(req.clientId);
    res.json({ success: true, position: pos, queueLength: queue.length });
});

app.post('/api/submit-captcha', (req, res) => {
    const { sessionId, userAnswer } = req.body;
    const clientId = req.clientId;

    if (!assignedCaptchas.has(sessionId)) return res.status(400).json({ success: false, message: "Ungültige Session" });

    const info = assignedCaptchas.get(sessionId);
    if (info.clientId !== clientId) return res.status(403).json({ success: false, message: "Session gehört nicht dir" });

    assignedCaptchas.delete(sessionId);
    removeFromQueue(clientId);
    userSessions.delete(clientId);

    if (availableCaptchas.length > 0) assignCaptchaToFirstInQueue();

    res.json({ success: true, message: "Captcha gespeichert" });
});

// --- Server starten ---
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    setInterval(loadCaptchas, 30 * 1000);
    setInterval(cleanQueue, 15 * 1000);
    loadCaptchas();
});
