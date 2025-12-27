"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventClickArg, EventMountArg } from "@fullcalendar/core";
import clsx from "clsx";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:5050";

type Classification = {
  meeting_type: string;
  role: string;
  emotional_intensity: string;
  topic_tags: string[];
};

type EventLoad = {
  id: string;
  title: string;
  description?: string;
  start: string;
  end: string;
  attendeeCount: number;
  userRole: string;
  classification: Classification;
  durationMinutes: number;
  mentalLoad: number;
  contextSwitchCost: number;
  totalLoad: number;
  recoveryMinutes: number;
  timeOfDay: string;
  socialLoad: number;
  capacityCost: number;
  capacityRemaining: number;
  explanation: {
    complexity: number;
    roleLoad: number;
    emotionalLoad: number;
    socialLoad: number;
    mentalLoad: number;
    contextSwitchCost: number;
    timeOfDayMultiplier: number;
    topicTags: string[];
  };
};

type Summary = {
  totalLoad: number;
  capacityRemaining: number;
  highRisk: boolean;
};

const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function Home() {
  const [events, setEvents] = useState<EventLoad[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventLoad | null>(null);
  const [voiceQuery, setVoiceQuery] = useState("");
  const [voiceResponse, setVoiceResponse] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [voiceWarning, setVoiceWarning] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "loading">("idle");
  const [eventSource, setEventSource] = useState<"mock" | "google">("mock");
  const [calendarOptions, setCalendarOptions] = useState<
    { id: string; summary: string; primary: boolean }[]
  >([]);
  const [calendarId, setCalendarId] = useState<string>("primary");
  const [selectedDayIndex, setSelectedDayIndex] = useState<number>(0);
  const [filter, setFilter] = useState<"all" | "events" | "meetings">("all");
  const [assistantActive, setAssistantActive] = useState(false);
  const [calendarTitle, setCalendarTitle] = useState<string>(formatMonthYear());
  const calendarRef = useRef<FullCalendar | null>(null);

  useEffect(() => {
    const fetchEvents = async (source: "mock" | "google") => {
      const response = await fetch(
        `${API_BASE}/api/events${
          source === "google"
            ? `?source=google&calendarId=${encodeURIComponent(calendarId)}`
            : ""
        }`
      );
      const data = await response.json();
      setEvents(data.events || []);
      setSummary(data.summary || null);
      if (data.events?.length) {
        setSelectedEvent(data.events[0]);
        setSelectedDayIndex(getWeekdayIndex(new Date(data.events[0].start)));
      }
    };

    fetchEvents(eventSource);
  }, [eventSource, calendarId]);

  useEffect(() => {
    if (eventSource !== "google") return;

    const fetchCalendars = async () => {
      const response = await fetch(`${API_BASE}/api/google/calendars`);
      const data = await response.json();
      if (data.calendars?.length) {
        setCalendarOptions(data.calendars);
        const primary = data.calendars.find(
          (calendar: { primary: boolean }) => calendar.primary
        );
        setCalendarId(primary?.id || data.calendars[0].id);
      }
    };

    fetchCalendars();
  }, [eventSource]);

  const backToBackIds = useMemo(() => {
    const ids = new Set<string>();
    const sorted = [...events].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const current = sorted[i];
      const gapMinutes =
        (new Date(current.start).getTime() - new Date(prev.end).getTime()) / 60000;
      if (gapMinutes >= 0 && gapMinutes <= 10) {
        ids.add(prev.id);
        ids.add(current.id);
      }
    }
    return ids;
  }, [events]);

  const calendarEvents = useMemo(() => {
    const primary = events
      .filter((event) => {
        if (filter === "all") return true;
        if (filter === "meetings") return event.classification.meeting_type !== "standup";
        return event.classification.meeting_type === "standup";
      })
      .map((event) => ({
        id: event.id,
        title: event.title,
        start: event.start,
        end: event.end,
        backgroundColor: loadToColor(event.mentalLoad),
        borderColor: loadToColor(event.mentalLoad),
        textColor: "#0f172a",
        extendedProps: event,
        classNames: backToBackIds.has(event.id) ? ["switch-glow"] : [],
      }));

    const recovery = events.map((event) => {
      const start = new Date(event.end);
      const end = new Date(start.getTime() + event.recoveryMinutes * 60000);
      return {
        id: `${event.id}-recovery`,
        title: "Recovery",
        start: start.toISOString(),
        end: end.toISOString(),
        display: "background" as const,
        backgroundColor: "rgba(148, 163, 184, 0.18)",
      };
    });

    return [...primary, ...recovery];
  }, [events, backToBackIds, filter]);

  const weeklyData = useMemo(() => {
    const base = WEEK_DAYS.map(() => 0.28);
    const totals = WEEK_DAYS.map(() => ({ sum: 0, count: 0 }));

    events.forEach((event) => {
      const index = getWeekdayIndex(new Date(event.start));
      totals[index].sum += event.totalLoad;
      totals[index].count += 1;
    });

    return base.map((fallback, index) => {
      if (!totals[index].count) return fallback;
      return clampValue(totals[index].sum / totals[index].count);
    });
  }, [events]);

  const weeklyMarkers = useMemo(() => {
    return WEEK_DAYS.map((_, index) => {
      const dayEvents = events.filter(
        (event) => getWeekdayIndex(new Date(event.start)) === index
      );
      const hasDecision = dayEvents.some(
        (event) => event.classification.meeting_type === "decision"
      );
      const hasContextSpike =
        dayEvents.length > 0 &&
        dayEvents.reduce((sum, event) => sum + event.contextSwitchCost, 0) /
          dayEvents.length >
          0.5;
      return { hasDecision, hasContextSpike };
    });
  }, [events]);

  const selectedDayEvents = useMemo(() => {
    return events.filter(
      (event) => getWeekdayIndex(new Date(event.start)) === selectedDayIndex
    );
  }, [events, selectedDayIndex]);

  const breakdown = useMemo(() => {
    if (!selectedDayEvents.length) {
      return {
        mental: 0.2,
        context: 0.15,
        emotional: 0.18,
        recovery: 0.12,
      };
    }

    const mental = average(selectedDayEvents.map((event) => event.mentalLoad));
    const context = average(
      selectedDayEvents.map((event) => event.contextSwitchCost)
    );
    const emotional = average(
      selectedDayEvents.map((event) => event.explanation.emotionalLoad)
    );
    const recovery = clampValue(
      average(selectedDayEvents.map((event) => event.recoveryMinutes)) / 60
    );

    return { mental, context, emotional, recovery };
  }, [selectedDayEvents]);

  const totalLoad = summary?.totalLoad ?? 0.32;
  const points = Math.round(totalLoad * 10 * 10) / 10;
  const subtitle = totalLoad < 0.35 ? "Balanced" : totalLoad < 0.65 ? "You're carrying a lot today" : "Near capacity";
  const subtitleTone =
    totalLoad < 0.35
      ? "a balanced"
      : totalLoad < 0.65
      ? "a heavier"
      : "a near-capacity";

  const handleEventClick = (info: EventClickArg) => {
    const extended = info.event.extendedProps as EventLoad | undefined;
    if (extended?.id) {
      setSelectedEvent(extended);
      setSelectedDayIndex(getWeekdayIndex(new Date(extended.start)));
    }
  };

  const handleEventMount = (info: EventMountArg) => {
    const extended = info.event.extendedProps as EventLoad | undefined;
    if (!extended) return;
    info.el.title = `Mental load: ${Math.round(
      extended.mentalLoad * 100
    )}% | Context switch: ${Math.round(
      extended.contextSwitchCost * 100
    )}% | Recovery: ${Math.round(extended.recoveryMinutes)} min`;
  };

  const runVoiceQuery = async (queryOverride?: string) => {
    const query = queryOverride || voiceQuery;
    if (!query) return;

    const voiceEvents = events.slice(0, 10).map((event) => ({
      title: event.title,
      start: event.start,
      end: event.end,
      classification: event.classification,
      mentalLoad: event.mentalLoad,
      totalLoad: event.totalLoad,
      recoveryMinutes: event.recoveryMinutes,
    }));

    setVoiceStatus("loading");
    setVoiceError("");
    setVoiceWarning("");
    try {
      const response = await fetch(`${API_BASE}/api/voice/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, summary, events: voiceEvents }),
      });
      const data = await response.json();
      setVoiceResponse(data.text || "");
      setVoiceWarning(data.warning || "");

      if (!response.ok) {
        setVoiceError(data.error || "Voice request failed.");
        return;
      }

      if (data.audio?.status === "ok") {
        const audio = new Audio(`data:audio/mpeg;base64,${data.audio.audioBase64}`);
        audio.play();
      } else if (data.audio?.status) {
        setVoiceError(data.audio.reason || "Voice audio unavailable.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice request failed.";
      setVoiceError(message);
    } finally {
      setVoiceStatus("idle");
    }
  };

  const handleVoiceCapture = () => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setVoiceResponse("Speech recognition is not supported in this browser.");
      return;
    }

    setAssistantActive(true);
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setVoiceQuery(transcript);
      runVoiceQuery(transcript);
      setAssistantActive(false);
    };

    recognition.onerror = () => {
      setAssistantActive(false);
    };

    recognition.start();
  };

  return (
    <div className="min-h-screen bg-[#0b0f1a] text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-10 px-6 pb-16 pt-10">
        <section
          className={clsx(
            "assistant-bar sticky top-0 z-10 rounded-3xl border border-white/5 bg-[#0f172a]/70 p-4 shadow-[0_20px_50px_rgba(15,23,42,0.4)] backdrop-blur transition",
            assistantActive && "assistant-bar--active"
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-xs uppercase tracking-[0.3em] text-slate-400">
                Calm Coach
              </span>
              <span className="text-sm text-slate-300">
                Yesterday you protected two recovery buffers. Want to plan another?
              </span>
            </div>
            <div
              className="flex flex-1 items-center gap-3 rounded-full border border-white/10 bg-[#0b1220] px-4 py-2 text-sm text-slate-300 transition focus-within:shadow-[0_0_0_4px_rgba(56,189,248,0.25)]"
              onFocusCapture={() => setAssistantActive(true)}
              onBlurCapture={() => setAssistantActive(false)}
            >
              <div className="sparkle-wrap">
                <span className="sparkle-dot" />
              </div>
              <input
                className="flex-1 bg-transparent text-xs text-slate-400 outline-none placeholder:text-slate-500"
                placeholder="Press CMD + K to ask assistant"
                value={voiceQuery}
                onChange={(event) => setVoiceQuery(event.target.value)}
              />
              <div className={clsx("voice-ripple", assistantActive && "voice-ripple--on")} />
              <button
                onClick={handleVoiceCapture}
                className="rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-200 transition hover:bg-white/20"
              >
                Talk
              </button>
              <button
                onClick={() => runVoiceQuery()}
                className="grid h-7 w-7 place-items-center rounded-full border border-white/10 bg-white/5 text-sm text-slate-200 transition hover:bg-white/10"
                aria-label="Send text"
              >
                ↑
              </button>
            </div>
          </div>
        </section>

        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-slate-400">
                Cognitive Calendar
              </p>
              <h1 className="text-4xl font-semibold text-slate-100">
                You don’t have time — you have capacity.
              </h1>
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300">
              Meetings aren’t equal. Your calendar should know that.
            </span>
          </div>
          <p className="max-w-3xl text-sm text-slate-400">
            Calm, capacity-first insight into mental load, context switching, and recovery — built
            for sustainable focus.
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button
              onClick={() => setEventSource("mock")}
              className={clsx(
                "rounded-full border px-4 py-1.5 font-medium transition",
                eventSource === "mock"
                  ? "border-slate-200 bg-slate-100 text-slate-900"
                  : "border-white/10 bg-white/5 text-slate-300"
              )}
            >
              Use mock calendar
            </button>
            <button
              onClick={() => setEventSource("google")}
              className={clsx(
                "rounded-full border px-4 py-1.5 font-medium transition",
                eventSource === "google"
                  ? "border-emerald-300 bg-emerald-300 text-slate-900"
                  : "border-emerald-300/30 bg-white/5 text-emerald-200"
              )}
            >
              Load Google Calendar
            </button>
            <a
              href={`${API_BASE}/api/google/oauth/start`}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 font-medium text-slate-300"
            >
              Connect Google Account
            </a>
            {eventSource === "google" && calendarOptions.length > 0 && (
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-slate-300">
                <span>Calendar</span>
                <select
                  value={calendarId}
                  onChange={(event) => setCalendarId(event.target.value)}
                  className="bg-transparent text-sm text-slate-200 outline-none"
                >
                  {calendarOptions.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.summary}
                      {calendar.primary ? " (Primary)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </header>

        <section className="rounded-3xl border border-white/5 bg-[#0f172a]/60 p-6 shadow-[0_25px_60px_rgba(8,15,28,0.6)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-2">
              <span className="text-sm uppercase tracking-[0.35em] text-slate-400">Calendar</span>
              <div className="text-3xl font-semibold text-slate-100">{calendarTitle}</div>
              <span className="text-xs text-slate-500">Today</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => calendarRef.current?.getApi().prev()}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400"
              >
                ◀
              </button>
              <button
                onClick={() => calendarRef.current?.getApi().next()}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400"
              >
                ▶
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 p-1">
              {["all", "events", "meetings"].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab as "all" | "events" | "meetings")}
                  className={clsx(
                    "rounded-full px-4 py-1 text-xs capitalize transition",
                    filter === tab
                      ? "bg-white text-slate-900"
                      : "text-slate-400"
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-slate-400">
              <span>Search</span>
              <input
                className="bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-500"
                placeholder="Find a meeting"
              />
            </div>
          </div>
          <div className="mt-6">
            <FullCalendar
              ref={calendarRef}
              plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
              initialView="timeGridWeek"
              height={640}
              headerToolbar={false}
              allDaySlot={false}
              slotMinTime="00:00:00"
              slotMaxTime="24:00:00"
              scrollTime="08:00:00"
              events={calendarEvents}
              eventClick={handleEventClick}
              eventDidMount={handleEventMount}
              datesSet={(info) => setCalendarTitle(formatMonthYear(info.start))}
              eventContent={(info) => {
                const extended = info.event.extendedProps as EventLoad | undefined;
                if (!extended?.id) return null;
                return (
                  <div className="flex h-full flex-col justify-between rounded-xl px-3 py-2 text-[11px] text-slate-900">
                    <span className="font-semibold">{info.event.title}</span>
                    <span className="text-[10px] text-slate-700">
                      {Math.round(extended.mentalLoad * 100)}% load
                    </span>
                  </div>
                );
              }}
            />
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl border border-white/5 bg-[#0f172a]/60 p-6 shadow-[0_25px_60px_rgba(8,15,28,0.6)]">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-400">
                  Today
                </h2>
                <h3 className="text-2xl font-semibold text-slate-100">Cognitive Load</h3>
              </div>
              <div className="text-right">
                <div className="text-4xl font-semibold text-slate-100">
                  {points.toFixed(1)} pts
                </div>
                <div className="text-sm text-slate-400">{subtitle}</div>
              </div>
            </div>
            <div className="mt-6 flex items-center gap-6">
              <div className="flex h-20 flex-1 items-end gap-2">
                {weeklyData.map((value, index) => (
                  <div key={WEEK_DAYS[index]} className="flex flex-1 flex-col items-center gap-2">
                    <div
                      className="w-full rounded-full bg-gradient-to-t from-emerald-400/40 via-amber-300/40 to-orange-300/40"
                      style={{ height: `${Math.max(12, value * 70)}px` }}
                    />
                    <span className="text-[10px] text-slate-400">{WEEK_DAYS[index]}</span>
                  </div>
                ))}
              </div>
              <div className="flex max-w-[160px] flex-col gap-2 text-xs text-slate-400">
                <span className="rounded-full bg-white/5 px-3 py-1">Optimal range</span>
                <span className="rounded-full bg-white/5 px-3 py-1">Stretch range</span>
                <span className="rounded-full bg-white/5 px-3 py-1">Recovery needed</span>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-white/5 bg-[#0f172a]/60 p-6 shadow-[0_25px_60px_rgba(8,15,28,0.6)]">
            <h2 className="text-lg font-semibold text-slate-100">Cognitive Load Meter</h2>
            <p className="mt-1 text-sm text-slate-400">
              A gentle snapshot of today&apos;s capacity, not a judgment.
            </p>
            <div className="mt-6 flex items-center justify-center">
              <Gauge value={totalLoad} />
            </div>
            <p className="mt-4 text-sm text-slate-400">
              You&apos;re pacing through {subtitleTone} intensity. Consider spacing decision-heavy
              meetings to keep recovery smooth.
            </p>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-white/5 bg-[#0f172a]/60 p-6 shadow-[0_25px_60px_rgba(8,15,28,0.6)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">Weekly cognitive rhythm</h2>
                <p className="text-sm text-slate-400">
                  Trends across the week, highlighting decision and context-switch days.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-amber-300" /> Decision-heavy
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-sky-300" /> Context spikes
                </span>
              </div>
            </div>
            <WeeklyAreaChart
              values={weeklyData}
              markers={weeklyMarkers}
              selectedIndex={selectedDayIndex}
              onSelect={setSelectedDayIndex}
            />
          </div>

          <div className="rounded-3xl border border-white/5 bg-[#0f172a]/60 p-6 shadow-[0_25px_60px_rgba(8,15,28,0.6)]">
            <h2 className="text-lg font-semibold text-slate-100">Why is today heavy?</h2>
            <p className="mt-1 text-sm text-slate-400">
              Contributions are shown as calm, relative weights — not raw formulas.
            </p>
            <div className="mt-6 space-y-4">
              <ContributionBar
                label="Mental Load"
                value={breakdown.mental}
                onClick={() => focusByMetric("mental", selectedDayEvents, setSelectedEvent)}
              />
              <ContributionBar
                label="Context Switching"
                value={breakdown.context}
                onClick={() => focusByMetric("context", selectedDayEvents, setSelectedEvent)}
              />
              <ContributionBar
                label="Emotional Load"
                value={breakdown.emotional}
                onClick={() => focusByMetric("emotional", selectedDayEvents, setSelectedEvent)}
              />
              <ContributionBar
                label="Recovery Debt"
                value={breakdown.recovery}
                onClick={() => focusByMetric("recovery", selectedDayEvents, setSelectedEvent)}
              />
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <aside className="rounded-3xl border border-white/5 bg-[#0f172a]/60 p-6 shadow-[0_25px_60px_rgba(8,15,28,0.6)]">
            <h2 className="text-lg font-semibold text-slate-100">Meeting insight</h2>
            {selectedEvent ? (
              <div className="mt-4 space-y-3 text-sm text-slate-300">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-100">{selectedEvent.title}</span>
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">
                    {Math.round(selectedEvent.totalLoad * 100)}% load
                  </span>
                </div>
                <div className="space-y-2">
                  <MetricRow label="Complexity" value={selectedEvent.explanation.complexity} />
                  <MetricRow label="Role load" value={selectedEvent.explanation.roleLoad} />
                  <MetricRow label="Emotional load" value={selectedEvent.explanation.emotionalLoad} />
                  <MetricRow label="Context switch" value={selectedEvent.explanation.contextSwitchCost} />
                  <MetricRow label="Social load" value={selectedEvent.explanation.socialLoad} />
                  <MetricRow label="Recovery" value={selectedEvent.recoveryMinutes / 60} suffix="h" />
                </div>
                <div className="rounded-2xl bg-white/5 px-4 py-3 text-xs text-slate-400">
                  Tags: {selectedEvent.explanation.topicTags.join(", ") || "None"}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-400">Select a meeting to see the breakdown.</p>
            )}
          </aside>

          <aside className="rounded-3xl border border-white/5 bg-[#0f172a]/60 p-6 shadow-[0_25px_60px_rgba(8,15,28,0.6)]">
            <h2 className="text-lg font-semibold text-slate-100">Voice summary</h2>
            <p className="mt-1 text-sm text-slate-400">
              Calm, supportive reflections on your day — ready for ElevenLabs.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <input
                className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 outline-none focus:border-slate-400"
                value={voiceQuery}
                onChange={(event) => setVoiceQuery(event.target.value)}
                placeholder="Ask about load, recovery, or moving meetings..."
              />
              <button
                onClick={() => runVoiceQuery()}
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900"
                disabled={voiceStatus === "loading"}
              >
                {voiceStatus === "loading" ? "Thinking..." : "Ask"}
              </button>
            </div>
            <button
              onClick={() => runVoiceQuery("How heavy is my day?")}
              className="mt-3 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-300"
            >
              Explain my day
            </button>
            {voiceResponse && (
              <div className="mt-4 rounded-2xl bg-white/5 px-4 py-3 text-sm text-slate-300">
                {voiceResponse}
              </div>
            )}
            {voiceError && (
              <div className="mt-4 rounded-2xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {voiceError}
              </div>
            )}
            {voiceWarning && (
              <div className="mt-4 rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                {voiceWarning}
              </div>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}

function MetricRow({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span>{label}</span>
      <span className="font-semibold text-slate-200">
        {Math.round(value * 100) / 100}
        {suffix || ""}
      </span>
    </div>
  );
}

function ContributionBar({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-white/5 bg-white/5 px-4 py-3 text-left transition hover:border-white/10"
    >
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span>{Math.round(value * 100)}%</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-white/5">
        <div
          className="h-2 rounded-full bg-gradient-to-r from-emerald-300/60 via-amber-200/60 to-orange-200/60"
          style={{ width: `${Math.max(12, value * 100)}%` }}
        />
      </div>
    </button>
  );
}

function WeeklyAreaChart({
  values,
  markers,
  selectedIndex,
  onSelect,
}: {
  values: number[];
  markers: { hasDecision: boolean; hasContextSpike: boolean }[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const points = values.map((value, index) => {
    const x = 10 + index * 15;
    const y = 40 - value * 28;
    return `${x},${y}`;
  });
  const linePath = `M ${points.join(" L ")}`;
  const areaPath = `${linePath} L ${10 + (values.length - 1) * 15},40 L 10,40 Z`;

  return (
    <div className="mt-6">
      <svg viewBox="0 0 100 45" className="h-36 w-full">
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#areaFill)" />
        <path d={linePath} fill="none" stroke="#e2e8f0" strokeWidth="1.4" />
        {values.map((value, index) => {
          const x = 10 + index * 15;
          const y = 40 - value * 28;
          const isSelected = index === selectedIndex;
          return (
            <g key={`marker-${index}`}>
              <circle
                cx={x}
                cy={y}
                r={isSelected ? 2.8 : 2}
                fill={isSelected ? "#f8fafc" : "#94a3b8"}
              />
              {markers[index]?.hasDecision && (
                <circle cx={x} cy={y - 6} r={2} fill="#fbbf24" />
              )}
              {markers[index]?.hasContextSpike && (
                <circle cx={x + 4} cy={y - 4} r={2} fill="#7dd3fc" />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-3 grid grid-cols-7 gap-2">
        {WEEK_DAYS.map((day, index) => (
          <button
            key={day}
            type="button"
            onClick={() => onSelect(index)}
            className={clsx(
              "rounded-full px-3 py-1 text-xs transition",
              index === selectedIndex
                ? "bg-white text-slate-900"
                : "bg-white/5 text-slate-400"
            )}
          >
            {day}
          </button>
        ))}
      </div>
    </div>
  );
}

function Gauge({ value }: { value: number }) {
  const angle = 180 - clampValue(value) * 180;
  const arcs = [
    { start: 180, end: 120, color: "#34d399" },
    { start: 120, end: 60, color: "#fbbf24" },
    { start: 60, end: 0, color: "#fb923c" },
  ];

  return (
    <div className="relative h-36 w-72">
      <svg viewBox="0 0 220 120" className="h-full w-full">
        <path
          d={describeArcGauge(110, 110, 86, 180, 0)}
          fill="none"
          stroke="#1f2937"
          strokeWidth="18"
          strokeLinecap="round"
        />
        {arcs.map((arc) => (
          <path
            key={arc.color}
            d={describeArcGauge(110, 110, 86, arc.start, arc.end)}
            fill="none"
            stroke={arc.color}
            strokeWidth="14"
            strokeLinecap="round"
          />
        ))}
        <line
          x1="110"
          y1="110"
          x2={110 + 68 * Math.cos((Math.PI / 180) * angle)}
          y2={110 - 68 * Math.sin((Math.PI / 180) * angle)}
          stroke="#e2e8f0"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="110" cy="110" r="6" fill="#e2e8f0" />
      </svg>
    </div>
  );
}

function describeArcGauge(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number
) {
  const start = polarToCartesianGauge(cx, cy, r, endAngle);
  const end = polarToCartesianGauge(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    "M",
    start.x,
    start.y,
    "A",
    r,
    r,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y,
  ].join(" ");
}

function polarToCartesianGauge(cx: number, cy: number, r: number, angle: number) {
  const radians = (Math.PI / 180) * angle;
  return {
    x: cx + r * Math.cos(radians),
    y: cy - r * Math.sin(radians),
  };
}

function getWeekdayIndex(date: Date) {
  const day = date.getDay();
  return day === 0 ? 6 : day - 1;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampValue(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function loadToColor(load: number) {
  if (load < 0.3) return "#86efac";
  if (load < 0.6) return "#fde68a";
  return "#fdba74";
}

function focusByMetric(
  metric: "mental" | "context" | "emotional" | "recovery",
  events: EventLoad[],
  select: (event: EventLoad) => void
) {
  if (!events.length) return;

  const sorted = [...events].sort((a, b) => {
    if (metric === "mental") return b.mentalLoad - a.mentalLoad;
    if (metric === "context") return b.contextSwitchCost - a.contextSwitchCost;
    if (metric === "emotional")
      return b.explanation.emotionalLoad - a.explanation.emotionalLoad;
    return b.recoveryMinutes - a.recoveryMinutes;
  });

  select(sorted[0]);
}

function formatMonthYear(date = new Date()) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
