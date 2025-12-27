require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { mockEvents } = require("./mockEvents");
const {
  getAuthUrl,
  exchangeCodeForTokens,
  hasTokens,
  fetchCalendarEvents,
  listCalendars,
} = require("./googleCalendar");
const {
  BASELINES,
  classifyWithGemini,
  computeEventLoads,
  buildDailySummary,
} = require("./logic");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/baselines", (_req, res) => {
  res.json(BASELINES);
});

app.get("/api/google/oauth/start", (_req, res) => {
  const url = getAuthUrl();
  if (!url) {
    res.status(400).json({ error: "Missing Google OAuth configuration." });
    return;
  }
  res.redirect(url);
});

app.get("/api/google/oauth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    res.status(400).json({ error: "Missing OAuth code." });
    return;
  }

  try {
    await exchangeCodeForTokens(code);
    const redirectTo = process.env.WEB_BASE_URL || "http://localhost:3000";
    res.redirect(redirectTo);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to exchange OAuth token." });
  }
});

app.get("/api/google/calendars", async (_req, res) => {
  if (!hasTokens()) {
    res.status(401).json({ error: "Not authenticated with Google." });
    return;
  }

  try {
    const calendars = await listCalendars();
    res.json({ calendars });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load calendars." });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const source = req.query.source;
    const calendarId = req.query.calendarId;
    let events = [...mockEvents];

    if (source === "google" && hasTokens()) {
      const now = new Date();
      const startOfRange = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfRange = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      endOfRange.setHours(23, 59, 59, 999);

      events = await fetchCalendarEvents({
        timeMin: startOfRange.toISOString(),
        timeMax: endOfRange.toISOString(),
        calendarId: calendarId || "primary",
      });
    }

    events.sort((a, b) => new Date(a.start) - new Date(b.start));

    const classified = [];
    for (const event of events) {
      const classification = await classifyWithGemini(event);
      classified.push({ ...event, classification });
    }

    const enriched = computeEventLoads(classified);
    const summary = buildDailySummary(enriched);

    res.json({ events: enriched, summary });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load events." });
  }
});

app.post("/api/voice/query", async (req, res) => {
  const { query, summary } = req.body || {};

  if (!query) {
    res.status(400).json({ error: "Missing query." });
    return;
  }

  const responseText = buildVoiceResponse(query, summary);
  const voice = await synthesizeVoice(responseText);

  res.json({ text: responseText, audio: voice });
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`Cognitive Calendar API running on :${PORT}`);
});

function buildVoiceResponse(query, summary) {
  const normalized = query.toLowerCase();
  const safeSummary = summary || {};
  const capacity = safeSummary.capacityRemaining ?? 100;
  const totalLoad = safeSummary.totalLoad ?? 0;
  const highRisk = safeSummary.highRisk;

  if (normalized.includes("how heavy")) {
    return `Your day is at ${Math.round(totalLoad * 100)} percent load. You have ${Math.round(
      capacity
    )} capacity units left. Remember, you don't have time — you have capacity.`;
  }

  if (normalized.includes("move")) {
    return "Yes, moving a high-load meeting later can protect your recovery buffer. Look for a slot with more capacity.";
  }

  if (normalized.includes("why")) {
    return "That meeting is expensive because the mental demand, emotional intensity, and context switching costs stack up. I can show the exact baseline factors in the explanation panel.";
  }

  if (highRisk) {
    return "Today is a higher burnout risk. Consider adding recovery buffers or reducing context switches.";
  }

  return "I'm here to help you protect your capacity. Ask about today's load, moving meetings, or why a meeting is costly.";
}

async function synthesizeVoice(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    return { status: "skipped", reason: "Missing ElevenLabs credentials." };
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("ElevenLabs error:", response.status, errorText);
    return {
      status: "error",
      reason: `ElevenLabs request failed (${response.status}).`,
      details: errorText,
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  const base64Audio = Buffer.from(arrayBuffer).toString("base64");

  return { status: "ok", audioBase64: base64Audio };
}
