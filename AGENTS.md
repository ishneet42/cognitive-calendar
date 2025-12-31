# AGENTS.md

## Project Overview
This repository contains Cognitive Calendar, a hackathon-ready prototype that visualizes cognitive load, context switching, and recovery buffers for calendar events.

## Key Directories
- `server/` Express API with Gemini classification + cognitive load heuristics.
- `web/` Next.js frontend UI.
- `cognitive-calender.ics` Sample calendar data file.

## Run Locally
- Backend: `cd server && npm install && npm run dev`
- Frontend: `cd web && npm install && npm run dev`

## Notes for Agents
- Do not modify the heuristic formulas or baseline tables in `server/logic.js` unless you are asked to.
- Keep outputs deterministic and explainable.
- Keep UI copy aligned with the product concept.
