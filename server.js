const express = require('express');
const axios = require('axios');
const app = express();
const path = require('path');
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Datenstrukturen ---
const availableCaptchas = [];
const assignedCaptchas = new Map();
const queue = [];
const queueMap = new Map();
const userSessions = new Map(); // ip -> { lastRequest, inQueue, assignedSession }

const QUEUE_TIMEOUT = 2 * 60 * 1000;

// --- Verbesserte IP-Erkennung ---
function getClientIp(req) {
    return req.ip || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress || 
           (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

// --- Synchronisierte Queue-Funktionen ---
function addToQueue(ip) {
    cleanQueue();
    
    // Wenn bereits in Queue, Position aktualisieren
    if (queueMap.has(ip)) {
        return getQueuePosition(ip);
    }
    
    const userEntry = { ip, timestamp: Date.now() };
    queue.push(userEntry);
    queueMap.set(ip, queue.length - 1);
    userSessions.set(ip, { 
        lastRequest: Date.now(), 
        inQueue: true,
        assignedSession: null
    });
    
    console.log(`[QUEUE] ${ip} hinzugefügt. Position: ${queue.length}`);
    return queue.length;
}

function removeFromQueue(ip) {
    const index = queueMap.get(ip);
    if (index !== undefined) {
        queue.splice(index, 1);
        queueMap.delete(ip);
        
        // Map neu aufbauen
        syncQueueMap();
        
        const userSession = userSessions.get(ip);
        if (userSession) {
            userSession.inQueue = false;
        }
        
        console.log(`[QUEUE] ${ip} entfernt. Verbleibende in Queue: ${queue.length}`);
    }
}

function getQueuePosition(ip) {
    const index = queueMap.get(ip);
    return index !== undefined ? index + 1 : -1;
}

function syncQueueMap() {
    queueMap.clear();
    queue.forEach((user, idx) => {
        queueMap.set(user.ip, idx);
    });
}

function cleanQueue() {
    const now = Date.now();
    let removedCount = 0;
    
    for (let i = queue.length - 1; i >= 0; i--) {
        if (now - queue[i].timestamp > QUEUE_TIMEOUT) {
            const ip = queue[i].ip;
            queue.splice(i, 1);
            queueMap.delete(ip);
            userSessions.delete(ip);
            removedCount++;
            console.log(`[QUEUE] ${ip} wegen Timeout entfernt`);
        }
    }
    
    if (removedCount > 0) {
        syncQueueMap();
    }
    
    return removedCount;
}

// --- Captcha sofort an erste Person in Queue geben ---
function assignCaptchaToFirstInQueue() {
    if (availableCaptchas.length > 0 && queue.length > 0) {
        const nextCaptcha = availableCaptchas.shift();
        const nextUser = queue[0]; // Immer die erste Person nehmen
        
        assignedCaptchas.set(nextCaptcha.id, { 
            ip: nextUser.ip, 
            captcha: nextCaptcha, 
            timestamp: Date.now() 
        });
        
        const userSession = userSessions.get(nextUser.ip);
        if (userSession) {
            userSession.assignedSession = nextCaptcha.id;
            userSession.inQueue = false;
        }
        
        console.log(`[ASSIGN] ${nextUser.ip} bekommt Captcha ${nextCaptcha.id}`);
        removeFromQueue(nextUser.ip);
        
        return true;
    }
    return false;
}

// --- Captchas laden ---
async function loadCaptchas() {
    try {
        const response = await axios.post("http://91.98.162.218/download", {
            channelId: 2,
            filename: "Captchas"
        }, { timeout: 15000 });

        const captchas = response.data.content || [];
        let newCaptchas = 0;

        captchas.forEach(c => {
            if (!assignedCaptchas.has(c.id) && !availableCaptchas.find(x => x.id === c.id)) {
                availableCaptchas.push(c);
                newCaptchas++;
            }
        });

        console.log(`[LOAD] ${newCaptchas} neue Captchas geladen. Total verfügbar: ${availableCaptchas.length}`);

        // Sofort verfügbare Captchas verteilen
        let assignedCount = 0;
        while (assignCaptchaToFirstInQueue()) {
            assignedCount++;
        }

        if (assignedCount > 0) {
            console.log(`[ASSIGN] ${assignedCount} Captchas an Warteschlange verteilt`);
        }

    } catch(err) {
        console.error('[ERROR] Fehler beim Laden:', err.message);
    }
}

// --- API Endpoints ---
app.get('/api/request-captcha', async (req, res) => {
    const ip = getClientIp(req);
    console.log(`[REQUEST] Captcha-Anfrage von ${ip}`);
    
    // User-Session aktualisieren
    userSessions.set(ip, {
        lastRequest: Date.now(),
        inQueue: userSessions.get(ip)?.inQueue || false,
        assignedSession: userSessions.get(ip)?.assignedSession || null
    });

    // Prüfen ob bereits ein Captcha zugewiesen ist
    for (let [sessionId, info] of assignedCaptchas.entries()) {
        if (info.ip === ip) {
            console.log(`[ASSIGNED] ${ip} hat bereits Captcha ${sessionId}`);
            removeFromQueue(ip); // Aus Queue entfernen falls noch drin
            
            return res.json({
                success: true,
                sessionId: sessionId,
                captchaUrl: info.captcha.url,
                instruction: info.captcha.instruction
            });
        }
    }

    cleanQueue();

    // Prüfen ob bereits in Queue
    const currentPosition = getQueuePosition(ip);
    if (currentPosition > 0) {
        console.log(`[QUEUE] ${ip} ist bereits in Position ${currentPosition}`);
        return res.json({
            success: false,
            message: "In Warteschlange",
            position: currentPosition,
            queueLength: queue.length
        });
    }

    // Neu in Queue aufnehmen
    const position = addToQueue(ip);
    
    // Sofort prüfen ob Captcha verfügbar
    if (position === 1 && availableCaptchas.length > 0) {
        console.log(`[IMMEDIATE] ${ip} bekommt sofort Captcha (Position 1)`);
        assignCaptchaToFirstInQueue();
        
        // Nochmal prüfen ob jetzt ein Captcha zugewiesen wurde
        for (let [sessionId, info] of assignedCaptchas.entries()) {
            if (info.ip === ip) {
                return res.json({
                    success: true,
                    sessionId: sessionId,
                    captchaUrl: info.captcha.url,
                    instruction: info.captcha.instruction
                });
            }
        }
    }

    console.log(`[QUEUE] ${ip} in Position ${position} von ${queue.length}`);
    res.json({
        success: false,
        message: "In Warteschlange",
        position: position,
        queueLength: queue.length
    });
});

app.get('/api/queue-position', (req, res) => {
    const ip = getClientIp(req);
    const position = getQueuePosition(ip);
    
    res.json({ 
        success: true, 
        position: position,
        queueLength: queue.length,
        estimatedWait: position > 0 ? Math.max(1, position * 0.5) : 0
    });
});

// Submit Endpoint (unverändert aber mit Queue-Cleanup)
app.post('/api/submit-captcha', (req, res) => {
    const { sessionId, userAnswer } = req.body;
    const ip = getClientIp(req);

    if (!assignedCaptchas.has(sessionId)) {
        return res.status(400).json({ success: false, message: "Ungültige Session" });
    }

    const info = assignedCaptchas.get(sessionId);
    if (info.ip !== ip) {
        return res.status(403).json({ success: false, message: "Session gehört nicht dir" });
    }

    console.log(`[SUBMIT] ${ip} löste Captcha ${sessionId}: ${userAnswer}`);
    
    assignedCaptchas.delete(sessionId);
    removeFromQueue(ip);
    userSessions.delete(ip);

    // Nächste Person in Queue bedienen
    if (availableCaptchas.length > 0) {
        assignCaptchaToFirstInQueue();
    }

    res.json({ success: true, message: "Captcha gespeichert" });
});

// --- Server starten ---
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    setInterval(loadCaptchas, 30 * 1000);
    setInterval(cleanQueue, 15 * 1000);
    loadCaptchas(); // Initial laden
});
