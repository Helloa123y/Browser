app.get('/api/request-captcha', async (req, res) => {
  try {
    // Zufällige Session-ID generieren
    const n = crypto.randomInt(0, 1_000_000_000);
    const sessionId = String(n).padStart(9, '0');

    console.log(`[INFO] Neue Captcha-Session ${sessionId} gestartet.`);

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

    // Erfolgreich → an Client zurückgeben
    res.json({
      sessionId,
      success: true,
      message: "Captchas erfolgreich geladen.",
      captchas: response.data
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
