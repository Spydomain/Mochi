import { State } from "../core/state";
import type { BotStateName } from "../core/layout";

export type DayPeriod = "morning" | "afternoon" | "evening" | "night";

export function periodAt(hour: number): DayPeriod {
  if (hour >= 22 || hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** Night is a gentle idle-only visual state, never an override of work or music. */
export function companionMoodState(state: BotStateName, night: boolean, musicPlaying: boolean): BotStateName {
  return night && state === "idle" && !musicPlaying ? "sleeping" : state;
}

export function greetingFor(hour: number): string {
  switch (periodAt(hour)) {
    case "morning": return "Good morning! Have a kind start to your day.";
    case "afternoon": return "Good afternoon! Remember to take a breath.";
    case "evening": return "Good evening! You've done enough for today.";
    case "night": return "Good night! A little rest will help tomorrow.";
  }
}

export function careReminder(hour: number): string {
  return hour >= 22 || hour < 6
    ? "Good night. You've been here a while — consider sleeping soon."
    : "You've been here a while. Stretch and drink some water.";
}

interface NoticeHost {
  showNotice(message: string): void;
  setNightMood(on: boolean): void;
}

const REMINDER_INTERVAL = 2 * 60 * 60 * 1000;
const NIGHT_REMINDER_INTERVAL = 60 * 60 * 1000;
const QUIET_VIEWS = new Set(["overview", "empty", "settings", "greeting"]);

export class Wellbeing {
  private host: NoticeHost;
  private startedAt = Date.now();
  private lastReminder = this.startedAt;
  private lastGreeting = 0;

  constructor(host: NoticeHost) { this.host = host; }

  start() {
    this.host.setNightMood(periodAt(new Date().getHours()) === "night");
    window.setInterval(() => this.check(), 60_000);
  }

  check(now = new Date()) {
    const night = periodAt(now.getHours()) === "night";
    this.host.setNightMood(night);
    if (State.paused || State.pendingApproval ||
      (State.mode === "expanded" && !QUIET_VIEWS.has(State.view)) ||
      State.view === "greeting") return;
    const localDay = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const key = `${localDay}.${periodAt(now.getHours())}`;
    if (now.getTime() - this.lastGreeting >= 3 * 60 * 60 * 1000 && localStorage.getItem("mochi.lastGreeting") !== key) {
      localStorage.setItem("mochi.lastGreeting", key);
      this.lastGreeting = now.getTime();
      if (night) localStorage.setItem("mochi.lastNightNoticeAt", String(now.getTime()));
      this.host.showNotice(greetingFor(now.getHours()));
      return;
    }
    const interval = night ? NIGHT_REMINDER_INTERVAL : REMINDER_INTERVAL;
    // A restarted app may inherit today's greeting but no recent reminder.
    // Keep this timestamp across restarts so it can say good night when due
    // without repeating the message every time the process launches.
    const lastNightNoticeAt = Number(localStorage.getItem("mochi.lastNightNoticeAt") ?? 0);
    if (night && this.lastGreeting === 0 && Number.isFinite(lastNightNoticeAt) &&
      now.getTime() - lastNightNoticeAt >= NIGHT_REMINDER_INTERVAL) {
      this.lastReminder = now.getTime();
      localStorage.setItem("mochi.lastNightNoticeAt", String(now.getTime()));
      this.host.showNotice(careReminder(now.getHours()));
      return;
    }
    if (now.getTime() - this.startedAt >= interval &&
      now.getTime() - this.lastReminder >= interval) {
      this.lastReminder = now.getTime();
      if (night) localStorage.setItem("mochi.lastNightNoticeAt", String(now.getTime()));
      this.host.showNotice(careReminder(now.getHours()));
    }
  }
}
