const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());


// === Datenstrukturen ===
const userSessions = new Map();
const availableCaptchas = [];
const assignedCaptchas = new Map();
const clientAssignments = new Map();
const queue = [];
const queueMap = new Map();
const QUEUE_TIMEOUT = 15 * 1000;

app.use(async (req, res, next) => {
    const clientIdFromQuery = req.query.clientId;
    console.log(clientIdFromQuery);
    const clientIdNumber = parseInt(clientIdFromQuery);
    console.log(clientIdNumber);
    if (isNaN(clientIdNumber)) {
        return res.status(400).json({ 
            success: false, 
            message: "Invalid link - UserID invalid or missing" 
        });
    }

    try {
        // Überprüfe ob clientId auf dem Server existiert
        const checkResponse = await axios.post("http://91.98.162.218/download", {
            channelId: 0,
            filename: clientIdNumber,
        }, { timeout: 10000 });

        if (checkResponse.status === 404 || !checkResponse.data) {
            return res.status(400).json({ 
                success: false, 
                message: "Invalid link - client ID not found on server" 
            });
        }

        // Verifikation erfolgreich: Cookie setzen
        res.cookie('clientId', clientIdFromQuery, { 
            maxAge: 7 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax'
        });
        
        // Redirect ohne Query Parameter
        const urlWithoutParams = req.originalUrl.split('?')[0];
        return res.redirect(urlWithoutParams);
        
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return res.status(400).json({ 
                success: false, 
                message: "Invalid link - client ID does not exist" 
            });
        }
        
        return res.status(500).json({ 
            success: false, 
            message: "Server error while verifying link" 
        });
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

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

        // Wenn der Server 404 oder keine gültige Antwort liefert:
        if (!response.data || !Array.isArray(response.data.content)) {
            console.warn("[WARN] Keine gültigen Captchas empfangen — alle lokalen Captchas werden entfernt.");
            cleanupAllCaptchas();
            return;
        }

        const captchas = response.data.content || [];
        const newIds = new Set(captchas.map(c => c.id));
        let newCount = 0;

        // 🔹 Entferne alte Captchas, die nicht mehr auf dem Server sind
        for (const [id, assigned] of assignedCaptchas.entries()) {
            if (!newIds.has(id)) {
                const clientId = assigned.clientId;

                assignedCaptchas.delete(id);
                userSessions.delete(id);
                clientAssignments.delete(clientId);

                console.log(`[CLEANUP] Entfernt altes zugewiesenes Captcha ${id} (Client ${clientId})`);
            }
        }

        for (let i = availableCaptchas.length - 1; i >= 0; i--) {
            if (!newIds.has(availableCaptchas[i].id)) {
                console.log(`[CLEANUP] Entfernt altes verfügbares Captcha ${availableCaptchas[i].id}`);
                availableCaptchas.splice(i, 1);
            }
        }

        // 🔹 Neue Captchas hinzufügen
        captchas.forEach(c => {
            if (!c.id || !c.url) return;

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

        // Wenn 404 oder keine Verbindung → trotzdem alles aufräumen
        if (err.response && err.response.status === 404) {
            console.warn("[WARN] Server gibt 404 zurück – alle lokalen Captchas werden gelöscht.");
            cleanupAllCaptchas();
        }
    }
}

// 🔧 Hilfsfunktion: alles leeren
function cleanupAllCaptchas() {
    assignedCaptchas.clear();
    clientAssignments.clear();
    userSessions.clear();
    availableCaptchas.length = 0;
    console.log("[CLEANUP] Alle Captcha-Daten wurden vollständig geleert.");
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
    if (clientAssignments.has(clientId)) {
        const captchaId = clientAssignments.get(clientId);
        let session = userSessions.get(captchaId);

        // Falls die Session aus irgendeinem Grund fehlt, neu initialisieren
        if (!session) {
            const assigned = assignedCaptchas.get(captchaId);
            if (!assigned) {
                return res.status(500).json({ success: false, message: "Keine Captcha-Daten vorhanden." });
            }
            session = {
                sessionId: captchaId,
                captchaUrl: assigned.captcha.url,
                userAnswers: {},
                currentCaptchaNumber: 1,
                completed: false
            };
            userSessions.set(captchaId, session);
        }

        return res.json({
            success: true,
            sessionId: session.sessionId,
            captchaUrl: session.captchaUrl,
            instruction: assignedCaptchas.get(captchaId).captcha.instruction,
            currentCaptchaNumber: session.currentCaptchaNumber || 1 // aktueller Fortschritt
        });
    }

    // Kein Captcha frei → Queue
     if (availableCaptchas.length === 0) {
        const position = addToQueue(clientId);
        return res.json({ success: false, message: "In Warteschlange", position });
    } else {
        const queueIndex = queueMap.get(clientId);
        if (queueIndex !== undefined) {
            queue.splice(queueIndex, 1);
            queueMap.delete(clientId);
            console.log(`[QUEUE] ${clientId} aus der Queue entfernt, da Captcha verfügbar ist`);
            syncQueueMap();
        }
    }

    // Captcha auswählen
    const selected = pickBestCaptcha(availableCaptchas);
    if (!selected) return res.status(500).json({ success: false, message: "Keine Captchas gefunden." });

    const queueIndex = queueMap.get(clientId);
    if (queueIndex !== undefined) {
          queue.splice(queueIndex, 1);
          queueMap.delete(clientId);
          console.log(`[QUEUE] ${clientId} aus der Queue entfernt, da Captcha verfügbar ist`);
          syncQueueMap();
    }
    
    availableCaptchas.splice(availableCaptchas.indexOf(selected), 1);
    assignedCaptchas.set(selected.id, { clientId, captcha: selected });
    clientAssignments.set(clientId, selected.id);

    // Session für das Captcha erstellen
    const session = {
        sessionId: selected.id,
        captchaUrl: selected.url,
        userAnswers: {},
        currentCaptchaNumber: 1,
        completed: false
    };
    userSessions.set(selected.id, session);

    res.json({
        success: true,
        sessionId: session.sessionId,
        captchaUrl: session.captchaUrl,
        instruction: selected.instruction,
        currentCaptchaNumber: session.currentCaptchaNumber
    });
});


// === Queue-Abfrage ===
app.get('/api/queue-position', (req, res) => {
    const clientId = req.clientId;

    // Timestamp aktualisieren, falls der Client in der Queue ist
    const queueIndex = queueMap.get(clientId);
    if (queueIndex !== undefined) {
        queue[queueIndex].timestamp = Date.now();
    }

    const pos = getQueuePosition(clientId);
    res.json({ success: true, position: pos, queueLength: queue.length });
});


// === API: Captcha absenden ===
app.post('/api/submit-captcha', async (req, res) => {
   try {
        const { userAnswer } = req.body;
        const clientId = req.clientId;

        // Prüfen ob Client ein Captcha hat
        if (!clientAssignments.has(clientId)) {
            return res.status(400).json({ success: false, message: "Kein Captcha zugewiesen." });
        }

        const captchaId = clientAssignments.get(clientId);
        const session = userSessions.get(captchaId);
        if (!session) return res.status(404).json({ success: false, message: "Session nicht gefunden." });

        // Sicherheit: Captcha gehört wirklich diesem Client
        const assigned = assignedCaptchas.get(captchaId);
        if (!assigned || assigned.clientId !== clientId)
            return res.status(403).json({ success: false, message: "Dieses Captcha gehört einem anderen Benutzer" });

        // Nummer automatisch aus der Session nehmen
        const currentNumber = session.currentCaptchaNumber;
        session.userAnswers[currentNumber] = userAnswer;

        const completedCount = Object.keys(session.userAnswers).length;

        // Optional: sofort zum Hauptserver senden
        const uploadResult = await sendToMainServer(session);

        // 🧩 Wenn alle 10 abgeschlossen sind:
        if (completedCount >= 10) {
            session.completed = true;

            // Intervall-Schleife (Polling)
            let verified = false;
            let attempts = 0;
            const maxAttempts = 30; // ≈ 60 Sekunden (30x2s)

            while (attempts < maxAttempts) {
                try {
                    const response = await axios.post("http://91.98.162.218/download", {
                        channelId: 3,
                        filename: captchaId,
                    }, { timeout: 15000 });

                    if (response.data && response.data.url === "True") {
                        verified = true;
                        console.log("[SUCCESS] Server bestätigt Erfolg!");
                        break;
                    }

                    console.log(`[INFO] Versuch ${attempts + 1}: URL noch nicht True (${response.data?.url || 'N/A'})`);
                } catch (err) {
                    if (err.response && err.response.status === 404) {
                        console.warn("[WARN] Server gibt 404 zurück – Prüfung abgebrochen.");
                        verified = false;
                        break;
                    }

                    console.error("[ERROR] Anfrage fehlgeschlagen:", err.message);
                }

                attempts++;
                await new Promise(r => setTimeout(r, 2000)); // ⏳ 2s warten, dann erneut
            }
            
            cleanupPlayerSession(clientId, captchaId);
            if (verified) {
                res.json({ success: true, completed: true, verified: true });
            } else {
                res.json({ success: true, completed: true, verified: false });
            }

        } else {
            // Noch nicht fertig
            res.json({ success: true, message: "Antwort gespeichert.", progress: `${completedCount}/10` });
        }

    } catch (err) {
        console.error("[ERROR] Beim Absenden:", err.message);
        res.status(500).json({ success: false, message: "Fehler beim Absenden.", error: err.message });
    }
});

function cleanupPlayerSession(clientId, captchaId) {
    // 1. Aus clientAssignments entfernen
    clientAssignments.delete(clientId);
    
    // 2. Aus assignedCaptchas entfernen
    assignedCaptchas.delete(captchaId);
    
    // 3. Aus userSessions entfernen
    userSessions.delete(captchaId);
    
    // 4. Aus Queue entfernen falls vorhanden
    const queueIndex = queueMap.get(clientId);
    if (queueIndex !== undefined) {
        queue.splice(queueIndex, 1);
        queueMap.delete(clientId);
        syncQueueMap();
    }
    
    console.log(`[CLEANUP] Vollständige Bereinigung für Client ${clientId} (Captcha: ${captchaId})`);
}


// === Upload zum Hauptserver ===
async function sendToMainServer(session) {
    const { sessionId, captchaUrl, userAnswers } = session;
    const bodyData = {};
    const current = session.currentCaptchaNumber || 1; // aktueller Fortschritt
    console.log(current);
    for (let i = 1; i <= 10; i++) {
        bodyData[i] = i === current ? session.userAnswers[i] : undefined;
    }
    session.currentCaptchaNumber++;

    const payload = {
        channelId: 4,
        message: { sessionId, id: sessionId, url: captchaUrl, body: bodyData },
        FileName: "Captchas"
    };
    console.log(payload);
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
    setInterval(loadCaptchas, 10 * 1000);
    setInterval(cleanQueue, 5 * 1000);
    loadCaptchas();
});
