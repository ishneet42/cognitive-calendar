# Cognitive Calendar

"You don't have time - you have capacity."

"Meetings aren't equal. Your calendar should know that."

Cognitive Calendar is a capacity-aware calendar that visualizes mental load, context switching, and recovery buffers. Gemini is used strictly for classification and all scoring is explainable through baseline tables and deterministic heuristics.

## What this demo shows

- Mental load per meeting (color intensity)
- Context switching spikes between meetings
- Recovery buffers rendered after meetings
- A daily capacity bar that depletes over time
- Voice assistant responses powered by ElevenLabs

## Heuristic model (explainable)

**Mental Load**
```
mentalLoad = (durationMinutes / 60) * (0.4 * complexity + 0.3 * roleLoad + 0.3 * emotionalLoad)
```

**Total Load**
```
totalLoad = mentalLoad + contextSwitchCost
```

**Recovery Time**
```
recoveryMinutes = totalLoad * 20 * timeOfDayMultiplier
```

Everything is normalized to 0.0–1.0 and clamped for determinism.

## Baseline tables (source of truth)

Meeting Type → Complexity
```
{ standup: 0.2, status: 0.3, demo: 0.4, planning: 0.6, brainstorming: 0.7, design_review: 0.8, decision: 0.9, conflict: 1.0 }
```

Role → Load
```
{ listener: 0.3, occasional_contributor: 0.5, contributor: 0.8, decision_maker: 1.0 }
```

Meeting Context → Emotional Load
```
{ routine: 0.2, external: 0.4, feedback: 0.6, performance: 0.8, conflict: 1.0 }
```

Participants → Social Load
```
{ "1-2": 0.2, "3-5": 0.4, "6-10": 0.6, "11-20": 0.8, "20+": 1.0 }
```

Topic Change Cost
```
{ same_project: 0.0, related_domain: 0.3, different_domain: 0.7, unrelated: 1.0 }
```

Gap Time Dampener
```
{ "0-5": 1.0, "5-15": 0.8, "15-30": 0.5, "30+": 0.2 }
```

Time-of-day multiplier
```
{ morning: 1.0, midday: 1.1, afternoon: 1.2, evening: 1.4 }
```

## System flow

Calendar event → Gemini classification → baseline lookup → heuristic cognitive load → recovery calculation → calendar visualization + voice feedback.

## Setup

### Backend

```
cd server
cp .env.example .env
npm install
npm run dev
```

Set `GCP_PROJECT_ID`, `GCP_LOCATION`, and `GOOGLE_APPLICATION_CREDENTIALS` for Gemini (Vertex AI). ElevenLabs requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.

### Frontend

```
cd web
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

## Sample data

Mock calendar data lives in `server/mockEvents.js` to make the demo deterministic. Gemini is used only to classify meetings into the allowed categories.

## Explainability

The explanation panel in the UI exposes the baseline values and the exact factors driving each meeting's cognitive cost. No black-box scoring is used.

## Voice interactions

Try asking:
- “How heavy is my day?”
- “Can I move this meeting?”
- “Why is this meeting expensive?”

The response is spoken with ElevenLabs and mirrored in text for transparency.
