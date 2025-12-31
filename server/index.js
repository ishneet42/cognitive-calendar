require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { GoogleAuth } = require("google-auth-library");
const { mockEvents } = require("./mockEvents");
const {
  getAuthUrl,
  exchangeCodeForTokens,
  hasTokens,
  fetchCalendarEvents,
  listCalendars,
  createCalendarEvent,
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
  const { query, summary, events, source, calendarId, tone } = req.body || {};

  if (!query) {
    res.status(400).json({ error: "Missing query." });
    return;
  }

  const actionResult = await handleVoiceAction({
    query,
    source,
    calendarId,
  });

  if (actionResult) {
    const responseText = actionResult.text;
    const voice = await synthesizeVoice(responseText);
    res.json({
      text: responseText,
      audio: voice,
      warning: actionResult.warning,
      action: actionResult.action,
      event: actionResult.event,
    });
    return;
  }

  const response = await buildVoiceResponseWithGemini(query, summary, events, tone);
  const responseText = response.text;
  const voice = await synthesizeVoice(responseText);

  res.json({ text: responseText, audio: voice, warning: response.warning });
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`Cognitive Calendar API running on :${PORT}`);
});

function buildVoiceResponse(query, summary, toneOverride) {
  const normalized = query.toLowerCase();
  const safeSummary = summary || {};
  const capacity = safeSummary.capacityRemaining ?? 100;
  const totalLoad = safeSummary.totalLoad ?? 0;
  const highRisk = safeSummary.highRisk;
  const tone = getVoiceTone({ query: normalized, summary: safeSummary, override: toneOverride });

  if (
    normalized.includes("how heavy") ||
    normalized.includes("summary") ||
    normalized.includes("explain")
  ) {
    return buildSummaryResponse({ tone, totalLoad, capacity, highRisk });
  }

  if (isPracticalQuery(normalized)) {
    return buildPracticalResponse({ totalLoad, capacity, highRisk });
  }

  if (normalized.includes("why")) {
    if (tone === "supportive") {
      return "That meeting takes more out of you because the mental demand, emotional intensity, and context switching stack up. We can look at the specific signals together in the explanation panel.";
    }
    if (tone === "practical") {
      return "That meeting is heavier because mental demand, emotional intensity, and context switching stack up. I can point to the exact signals in the explanation panel.";
    }
    return "That meeting is heavier because mental demand, emotional intensity, and context switching stack up. I can show the exact signals in the explanation panel.";
  }

  if (highRisk && tone === "supportive") {
    return "Today asked a lot from you. Nothing is wrong — it was simply a full day. Even a small pause tomorrow could help you reset.";
  }

  if (tone === "practical") {
    return "I can help you protect capacity by moving or spacing meetings. Tell me what you want to adjust, and I’ll suggest a low-impact change.";
  }
  if (tone === "supportive") {
    return "I’m here to help you protect your capacity, especially on full days. Ask about today’s load, recovery buffers, or spacing meetings.";
  }
  return "I’m here to help you notice patterns in your capacity. Ask about today’s load, recovery buffers, or why a meeting feels costly.";
}

function getVoiceTone({ query, summary, override }) {
  if (override && override !== "auto") {
    return normalizeVoiceTone(override);
  }
  if (isPracticalQuery(query)) return "practical";
  if (summary?.highRisk || (summary?.totalLoad ?? 0) >= 0.65) return "supportive";
  return "reflective";
}

function normalizeVoiceTone(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "supportive") return "supportive";
  if (normalized === "practical") return "practical";
  return "reflective";
}

function isPracticalQuery(query) {
  return (
    query.includes("move") ||
    query.includes("reschedule") ||
    query.includes("shift") ||
    query.includes("swap") ||
    query.includes("what should i move") ||
    query.includes("what can i move") ||
    query.includes("how can i recover") ||
    query.includes("recovery") ||
    query.includes("buffer") ||
    query.includes("plan") ||
    query.includes("schedule")
  );
}

function buildSummaryResponse({ tone, totalLoad, capacity, highRisk }) {
  const loadPercent = Math.round(totalLoad * 100);
  const capacityLeft = Math.round(capacity);
  if (tone === "supportive") {
    return `Today asked a lot from you. Nothing is wrong — it was simply a full day. You still have about ${capacityLeft} capacity points left.`;
  }
  if (tone === "practical") {
    return `Your day is around ${loadPercent}% load with about ${capacityLeft} capacity points left. If you want, we can move or space one meeting to create a clean recovery break.`;
  }
  if (highRisk) {
    return `Today was full, with around ${loadPercent}% load. You kept some recovery space, which helps balance the day.`;
  }
  return `Today had a steady load, around ${loadPercent}%. You kept some recovery space, which helped balance the day.`;
}

function buildPracticalResponse({ totalLoad, capacity, highRisk }) {
  const loadPercent = Math.round(totalLoad * 100);
  const capacityLeft = Math.round(capacity);
  if (highRisk || totalLoad >= 0.65) {
    return `Tomorrow looks tight with about ${loadPercent}% load. Moving one meeting or adding a buffer could create a clean break. I can suggest which one, if you’d like.`;
  }
  return `You have about ${capacityLeft} capacity points left. Moving one meeting could create a clean break. I can suggest which one, if you’d like.`;
}

function looksLikeCreateEvent(query) {
  const normalized = query.toLowerCase();
  return (
    normalized.includes("add event") ||
    normalized.includes("create event") ||
    normalized.includes("schedule") ||
    normalized.includes("book") ||
    normalized.includes("add meeting") ||
    normalized.includes("create meeting")
  );
}

function parseJsonResponse(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (_error) {
    return null;
  }
}

function formatEventConfirmation(event, timeZone) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const formatOptions = {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  const startText = start.toLocaleString("en-US", formatOptions);
  const endText = end.toLocaleString("en-US", formatOptions);
  return `Added "${event.title}" on ${startText} to ${endText}.`;
}

function hasTimeZoneOffset(value) {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value || "");
}

async function handleVoiceAction({ query, source, calendarId }) {
  if (!looksLikeCreateEvent(query)) {
    return null;
  }

  if (!process.env.GCP_PROJECT_ID || !process.env.GCP_LOCATION) {
    return {
      action: "create_event",
      text: "Event creation needs Gemini configured. Set GCP_PROJECT_ID and GCP_LOCATION.",
      warning: "Gemini is not configured for event creation.",
    };
  }

  const parsed = await parseEventRequestWithGemini(query);
  if (!parsed || parsed.action !== "create_event") {
    return {
      action: "create_event",
      text: "I couldn't read the event details. Try: Add event on Dec 31, 2025 from 1pm to 2pm for Meeting with Investors.",
      warning: "Gemini did not return a valid event.",
    };
  }

  const fallbackZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeZone = parsed.timeZone || fallbackZone;
  const startDate = parsed.start ? new Date(parsed.start) : null;
  const endDate = parsed.end ? new Date(parsed.end) : null;
  if (!startDate || Number.isNaN(startDate.valueOf())) {
    return {
      action: "create_event",
      text: "I couldn't find a valid event start time. Please provide a date and time.",
      warning: "Missing event start time.",
    };
  }

  const finalEnd =
    endDate && !Number.isNaN(endDate.valueOf())
      ? endDate
      : new Date(startDate.getTime() + 60 * 60 * 1000);
  const inferredTimeZone = hasTimeZoneOffset(parsed.start) ? undefined : timeZone;

  const eventPayload = {
    title: parsed.title || "New Event",
    description: parsed.description || "",
    start: parsed.start || startDate.toISOString(),
    end: parsed.end || finalEnd.toISOString(),
    timeZone: inferredTimeZone,
  };

  if (source === "google") {
    if (!hasTokens()) {
      return {
        action: "create_event",
        text: "You're not connected to Google Calendar yet. Please sign in first.",
        warning: "Missing Google Calendar tokens.",
      };
    }

    const created = await createCalendarEvent({
      calendarId: calendarId || "primary",
      ...eventPayload,
    });

    if (!created) {
      return {
        action: "create_event",
        text: "I couldn't create the event. Check Google Calendar permissions.",
        warning: "Google Calendar insert failed.",
      };
    }

    return {
      action: "create_event",
      text: formatEventConfirmation(
        { ...created, title: eventPayload.title },
        timeZone || fallbackZone
      ),
      event: created,
    };
  }

  const mockEvent = {
    id: `evt-${Date.now()}`,
    title: eventPayload.title,
    description: eventPayload.description,
    start: eventPayload.start,
    end: eventPayload.end,
    attendeeCount: 1,
    userRole: "contributor",
    meetingType: "status",
    emotionalIntensity: "routine",
    topicTags: [],
  };
  mockEvents.push(mockEvent);

  return {
    action: "create_event",
    text: formatEventConfirmation(mockEvent, timeZone || fallbackZone),
    event: mockEvent,
  };
}

async function buildVoiceResponseWithGemini(query, summary, events, toneOverride) {
  if (!process.env.GCP_PROJECT_ID || !process.env.GCP_LOCATION) {
    return {
      text: buildVoiceResponse(query, summary, toneOverride),
      warning: "Gemini is not configured. Set GCP_PROJECT_ID and GCP_LOCATION.",
    };
  }

  try {
    const debug = process.env.GEMINI_DEBUG === "true";
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 300);
    const endpoint = `https://${process.env.GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${process.env.GCP_PROJECT_ID}/locations/${process.env.GCP_LOCATION}/publishers/google/models/${model}:generateContent`;
    const summaryText = JSON.stringify(summary || {});
    const now = new Date();
    const normalizedQuery = query.toLowerCase();
    const tone = getVoiceTone({
      query: normalizedQuery,
      summary: summary || {},
      override: toneOverride,
    });
    const toneGuidance =
      tone === "supportive"
        ? "Tone: Supportive. Warm, reassuring, slower cadence, emotionally validating."
        : tone === "practical"
        ? "Tone: Practical. Calm, clear, slightly more direct, gentle and non-urgent."
        : "Tone: Reflective. Calm, observational, non-directive, slightly slower pacing.";
    const wantsToday =
      normalizedQuery.includes("today") ||
      normalizedQuery.includes("current date") ||
      normalizedQuery.includes("today's date") ||
      normalizedQuery.includes("current day");

    const sourceEvents = Array.isArray(events) ? events : [];
    const todayEvents = sourceEvents.filter((event) => {
      const start = new Date(event.start);
      if (Number.isNaN(start.valueOf())) {
        return false;
      }
      return (
        start.getFullYear() === now.getFullYear() &&
        start.getMonth() === now.getMonth() &&
        start.getDate() === now.getDate()
      );
    });
    const filteredEvents = wantsToday ? todayEvents : sourceEvents;

    const eventLines = filteredEvents.slice(0, 10).map((event) => {
      const title = event.title || "Untitled";
      const start = event.start || "unknown start";
      const end = event.end || "unknown end";
      const mentalLoad = event.mentalLoad ?? "n/a";
      const totalLoad = event.totalLoad ?? "n/a";
      const recoveryMinutes = event.recoveryMinutes ?? "n/a";
      const classification = event.classification || {};
      return [
        `title=${title}`,
        `start=${start}`,
        `end=${end}`,
        `mentalLoad=${mentalLoad}`,
        `totalLoad=${totalLoad}`,
        `recoveryMinutes=${recoveryMinutes}`,
        `meeting_type=${classification.meeting_type || "n/a"}`,
        `role=${classification.role || "n/a"}`,
        `emotional_intensity=${classification.emotional_intensity || "n/a"}`,
      ].join(" | ");
    });

    const todayLines = todayEvents.slice(0, 10).map((event) => {
      const title = event.title || "Untitled";
      const start = event.start || "unknown start";
      const end = event.end || "unknown end";
      return [`title=${title}`, `start=${start}`, `end=${end}`].join(" | ");
    });

    const prompt = `You are a calm calendar coach.
Use the calendar summary and events to answer the user's question.
If the data is insufficient, say what is missing.
Always use the provided current date/time as the source of truth for "today".
If the user asks about today, rely on the "Today's events" list.
Keep the response concise (1-3 sentences).
${toneGuidance}

Current date/time: ${now.toISOString()} (local: ${now.toString()})
Calendar summary JSON: ${summaryText}
Today's events (max 10):
${todayLines.join("\n")}
Upcoming events (max 10):
${eventLines.join("\n")}

User question: ${query}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token || token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.error("Gemini voice request failed", {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return {
        text: buildVoiceResponse(query, summary, toneOverride),
        warning: debug
          ? `Gemini request failed (${response.status} ${response.statusText}). ${errorBody}`
          : "Gemini request failed. Check Vertex AI API and credentials.",
      };
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      return {
        text: buildVoiceResponse(query, summary, toneOverride),
        warning: "Gemini returned no content. Check model and request format.",
      };
    }

    const finishReason = candidate?.finishReason;
    const warning =
      finishReason === "MAX_TOKENS"
        ? "Gemini response may be truncated. Increase GEMINI_MAX_OUTPUT_TOKENS."
        : "";

    return { text: text.trim(), warning };
  } catch (error) {
    console.error("Gemini voice response failed", error);
    return {
      text: buildVoiceResponse(query, summary, toneOverride),
      warning: "Gemini error. Verify credentials and Vertex AI permissions.",
    };
  }
}

async function parseEventRequestWithGemini(query) {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const endpoint = `https://${process.env.GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${process.env.GCP_PROJECT_ID}/locations/${process.env.GCP_LOCATION}/publishers/google/models/${model}:generateContent`;

  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const prompt = `You extract event creation details from user requests.
Return JSON only with keys: action, title, description, start, end, timeZone.
- action must be "create_event" or "none".
- start and end must be ISO-8601 date-time strings with timezone offsets.
- Use the provided timeZone if the user does not specify one.
- If the request is not to create an event, return {"action":"none"}.

Current date/time: ${now.toISOString()} (local: ${now.toString()})
Default timeZone: ${timeZone}
User request: ${query}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token || token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.error("Gemini event parse failed", {
      status: response.status,
      statusText: response.statusText,
      body: errorBody,
    });
    return null;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseJsonResponse(text);
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
