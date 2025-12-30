const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const tokenStore = {
  tokens: null,
};

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getAuthUrl() {
  const client = getOAuthClient();
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

async function exchangeCodeForTokens(code) {
  const client = getOAuthClient();
  if (!client) return null;

  const { tokens } = await client.getToken(code);
  tokenStore.tokens = tokens;
  return tokens;
}

function hasTokens() {
  return Boolean(tokenStore.tokens?.access_token);
}

async function fetchCalendarEvents({ timeMin, timeMax, calendarId = "primary" }) {
  const client = getOAuthClient();
  if (!client || !tokenStore.tokens) {
    return [];
  }

  client.setCredentials(tokenStore.tokens);
  const calendar = google.calendar({ version: "v3", auth: client });

  const response = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
  });

  const items = response.data.items || [];
  return items.map((item) => mapGoogleEvent(item));
}

async function createCalendarEvent({
  calendarId = "primary",
  title,
  description,
  start,
  end,
  timeZone,
}) {
  const client = getOAuthClient();
  if (!client || !tokenStore.tokens) {
    return null;
  }

  client.setCredentials(tokenStore.tokens);
  const calendar = google.calendar({ version: "v3", auth: client });
  const response = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title || "New Event",
      description: description || "",
      start: timeZone ? { dateTime: start, timeZone } : { dateTime: start },
      end: timeZone ? { dateTime: end, timeZone } : { dateTime: end },
    },
  });

  if (!response.data) {
    return null;
  }

  return mapGoogleEvent(response.data);
}

async function listCalendars() {
  const client = getOAuthClient();
  if (!client || !tokenStore.tokens) {
    return [];
  }

  client.setCredentials(tokenStore.tokens);
  const calendar = google.calendar({ version: "v3", auth: client });
  const response = await calendar.calendarList.list();
  const items = response.data.items || [];

  return items.map((item) => ({
    id: item.id,
    summary: item.summary,
    primary: Boolean(item.primary),
  }));
}

function mapGoogleEvent(item) {
  const start = item.start?.dateTime || item.start?.date;
  const end = item.end?.dateTime || item.end?.date;

  const startDate = new Date(start);
  let endDate = end ? new Date(end) : new Date(startDate.getTime() + 3600000);

  if (item.start?.date && item.end?.date) {
    startDate.setHours(9, 0, 0, 0);
    endDate = new Date(startDate.getTime() + 3600000);
  }

  return {
    id: item.id || `${startDate.getTime()}`,
    title: item.summary || "Untitled Meeting",
    description: item.description || "",
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    attendeeCount: item.attendees?.length || 1,
    userRole: "contributor",
    meetingType: "status",
    emotionalIntensity: "routine",
    topicTags: buildTopicTags(item.summary || ""),
  };
}

function buildTopicTags(summary) {
  if (!summary) return ["general"];
  return summary
    .toLowerCase()
    .split(/\\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, 3);
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  hasTokens,
  fetchCalendarEvents,
  listCalendars,
  createCalendarEvent,
};
