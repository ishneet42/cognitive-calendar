const { GoogleAuth } = require("google-auth-library");

const BASELINES = {
  meetingType: {
    standup: 0.2,
    status: 0.3,
    demo: 0.4,
    planning: 0.6,
    brainstorming: 0.7,
    design_review: 0.8,
    decision: 0.9,
    conflict: 1.0,
  },
  roleLoad: {
    listener: 0.3,
    occasional_contributor: 0.5,
    contributor: 0.8,
    decision_maker: 1.0,
  },
  emotionalLoad: {
    routine: 0.2,
    external: 0.4,
    feedback: 0.6,
    performance: 0.8,
    conflict: 1.0,
  },
  socialLoad: {
    "1-2": 0.2,
    "3-5": 0.4,
    "6-10": 0.6,
    "11-20": 0.8,
    "20+": 1.0,
  },
  topicChangeCost: {
    same_project: 0.0,
    related_domain: 0.3,
    different_domain: 0.7,
    unrelated: 1.0,
  },
  gapTimeDampener: {
    "0-5": 1.0,
    "5-15": 0.8,
    "15-30": 0.5,
    "30+": 0.2,
  },
  timeOfDayMultiplier: {
    morning: 1.0,
    midday: 1.1,
    afternoon: 1.2,
    evening: 1.4,
  },
};

const GEMINI_PROMPT = `You are classifying work meetings for cognitive load estimation.

Use ONLY the allowed values.

Meeting details:
Title: {{title}}
Description: {{description}}
Attendees: {{attendee_count}}
User role: {{user_role}}

Return JSON with:
- meeting_type: one of [standup, status, demo, planning, brainstorming, design_review, decision, conflict]
- role: one of [listener, occasional_contributor, contributor, decision_maker]
- emotional_intensity: one of [routine, external, feedback, performance, conflict]
- topic_tags: up to 3 short tags

Respond with JSON only. No explanations.`;

async function classifyWithGemini(event) {
  if (!process.env.GCP_PROJECT_ID || !process.env.GCP_LOCATION) {
    return fallbackClassification(event);
  }

  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const endpoint = `https://${process.env.GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${process.env.GCP_PROJECT_ID}/locations/${process.env.GCP_LOCATION}/publishers/google/models/${model}:generateContent`;

    const prompt = GEMINI_PROMPT.replace("{{title}}", event.title)
      .replace("{{description}}", event.description || "")
      .replace("{{attendee_count}}", event.attendeeCount)
      .replace("{{user_role}}", event.userRole || "contributor");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token || token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.error("Gemini classification request failed", {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
      });
      return fallbackClassification(event);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    return parseGeminiOutput(text, event);
  } catch (error) {
    console.error("Gemini classification failed", error);
    return fallbackClassification(event);
  }
}

function parseGeminiOutput(text, event) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed.meeting_type || !parsed.role || !parsed.emotional_intensity) {
      return fallbackClassification(event);
    }
    return {
      meeting_type: parsed.meeting_type,
      role: parsed.role,
      emotional_intensity: parsed.emotional_intensity,
      topic_tags: Array.isArray(parsed.topic_tags) ? parsed.topic_tags : [],
    };
  } catch (_error) {
    return fallbackClassification(event);
  }
}

function fallbackClassification(event) {
  return {
    meeting_type: event.meetingType || "status",
    role: event.userRole || "contributor",
    emotional_intensity: event.emotionalIntensity || "routine",
    topic_tags: event.topicTags || ["general"],
  };
}

function computeEventLoads(events) {
  let runningCapacity = 100;
  const enriched = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const prev = enriched[i - 1];
    const computed = computeSingleEvent(event, prev);

    runningCapacity = Math.max(0, runningCapacity - computed.capacityCost);
    enriched.push({
      ...computed,
      capacityRemaining: runningCapacity,
    });
  }

  return enriched;
}

function computeSingleEvent(event, prev) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const durationMinutes = Math.max(15, (end - start) / 60000);

  const complexity = BASELINES.meetingType[event.classification.meeting_type] ?? 0.3;
  const roleLoad = BASELINES.roleLoad[event.classification.role] ?? 0.5;
  const emotionalLoad =
    BASELINES.emotionalLoad[event.classification.emotional_intensity] ?? 0.4;

  const mentalLoadRaw =
    (durationMinutes / 60) *
    (0.4 * complexity + 0.3 * roleLoad + 0.3 * emotionalLoad);
  const mentalLoad = clamp(mentalLoadRaw);

  const contextSwitchCost = computeContextSwitch(event, prev);
  const totalLoad = clamp(mentalLoad + contextSwitchCost);

  const timeOfDay = getTimeOfDay(start);
  const recoveryMinutes =
    totalLoad * 20 * (BASELINES.timeOfDayMultiplier[timeOfDay] || 1.0);

  const socialLoad = mapSocialLoad(event.attendeeCount || 1);
  const capacityCost = totalLoad * 100;

  return {
    ...event,
    durationMinutes,
    mentalLoad,
    contextSwitchCost,
    totalLoad,
    recoveryMinutes,
    timeOfDay,
    socialLoad,
    capacityCost,
    explanation: {
      complexity,
      roleLoad,
      emotionalLoad,
      socialLoad,
      mentalLoad,
      contextSwitchCost,
      timeOfDayMultiplier: BASELINES.timeOfDayMultiplier[timeOfDay] || 1.0,
      topicTags: event.classification.topic_tags,
    },
  };
}

function computeContextSwitch(event, prev) {
  if (!prev) return 0;

  const overlap = event.classification.topic_tags?.some((tag) =>
    prev.classification.topic_tags?.includes(tag)
  );
  const topicCost = overlap
    ? BASELINES.topicChangeCost.related_domain
    : BASELINES.topicChangeCost.unrelated;

  const gapMinutes = Math.max(
    0,
    (new Date(event.start) - new Date(prev.end)) / 60000
  );
  const gapDampener = mapGapDampener(gapMinutes);

  return clamp(topicCost * gapDampener);
}

function mapGapDampener(minutes) {
  if (minutes <= 5) return BASELINES.gapTimeDampener["0-5"];
  if (minutes <= 15) return BASELINES.gapTimeDampener["5-15"];
  if (minutes <= 30) return BASELINES.gapTimeDampener["15-30"];
  return BASELINES.gapTimeDampener["30+"];
}

function mapSocialLoad(attendees) {
  if (attendees <= 2) return BASELINES.socialLoad["1-2"];
  if (attendees <= 5) return BASELINES.socialLoad["3-5"];
  if (attendees <= 10) return BASELINES.socialLoad["6-10"];
  if (attendees <= 20) return BASELINES.socialLoad["11-20"];
  return BASELINES.socialLoad["20+"];
}

function getTimeOfDay(date) {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 15) return "midday";
  if (hour < 18) return "afternoon";
  return "evening";
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function buildDailySummary(events) {
  const totalLoad = clamp(
    events.reduce((sum, event) => sum + event.totalLoad, 0) / Math.max(events.length, 1)
  );
  const capacityRemaining = Math.max(0, 100 - events.reduce((sum, e) => sum + e.capacityCost, 0));

  return {
    totalLoad,
    capacityRemaining,
    highRisk: capacityRemaining < 20,
  };
}

module.exports = {
  BASELINES,
  classifyWithGemini,
  computeEventLoads,
  buildDailySummary,
};
