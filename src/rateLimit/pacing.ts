import type { Log } from "../log.js";
import type { UnipileWorkingHours, Weekday } from "../types.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the event loop alive just for pacing delays.
    t.unref();
  });
}

export function randInt(min: number, max: number): number {
  if (max <= min) return Math.max(0, min);
  return Math.floor(min + Math.random() * (max - min + 1));
}

export async function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = randInt(minMs, maxMs);
  if (ms > 0) await sleep(ms);
}

/**
 * Sleep for `totalMs`, but subdivide the wait into `intervalMs` chunks and
 * invoke `onTick(remainingMs)` after each chunk. Emits an initial tick at the
 * start too so harnesses know the wait has begun. Used by gate() to keep the
 * agent tool-call "alive" during long spacing waits — most harnesses reset
 * their per-tool timeout when they see a progress update.
 */
export async function sleepWithHeartbeat(
  totalMs: number,
  intervalMs: number,
  onTick: (remainingMs: number) => void,
): Promise<void> {
  if (totalMs <= 0) return;
  onTick(totalMs);
  let remaining = totalMs;
  const slice = Math.max(1, intervalMs);
  while (remaining > 0) {
    const chunk = Math.min(slice, remaining);
    await sleep(chunk);
    remaining -= chunk;
    if (remaining > 0) onTick(remaining);
  }
}

function resolveTimezone(tz: string): string | undefined {
  if (!tz || tz === "system") return undefined;
  return tz;
}

function parseHm(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

const invalidTimezoneWarned = new Set<string>();

const INTL_WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

function currentHmInTz(
  tz: string | undefined,
  now: Date,
  log: Log,
): { h: number; m: number; day: Weekday } {
  const fallback = (): { h: number; m: number; day: Weekday } => ({
    h: now.getHours(),
    m: now.getMinutes(),
    day: INTL_WEEKDAYS[now.getDay()] ?? "mon",
  });
  if (!tz) return fallback();
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
      timeZone: tz,
    });
    const parts = fmt.formatToParts(now);
    const rawH = parts.find((p) => p.type === "hour")?.value ?? "0";
    const rawM = parts.find((p) => p.type === "minute")?.value ?? "0";
    const rawDay = parts.find((p) => p.type === "weekday")?.value ?? "";
    // Node/ICU with hour12:false may emit "24" for midnight — normalize to 0.
    const h = Number(rawH) % 24;
    const m = Number(rawM);
    const dayKey = rawDay.slice(0, 3).toLowerCase() as Weekday;
    if (!INTL_WEEKDAYS.includes(dayKey)) return fallback();
    return { h, m, day: dayKey };
  } catch {
    if (!invalidTimezoneWarned.has(tz)) {
      invalidTimezoneWarned.add(tz);
      log.warn(`invalid timezone '${tz}' in workingHours config — falling back to host TZ`);
    }
    return fallback();
  }
}

export interface WorkingHoursCheck {
  ok: boolean;
  windowLabel: string;
}

function formatDays(days: readonly Weekday[]): string {
  if (days.length === 7) return "every day";
  const weekdays: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
  if (days.length === 5 && weekdays.every((d) => days.includes(d))) return "Mon–Fri";
  return days.map((d) => WEEKDAY_LABELS[d]).join(", ");
}

export function checkWorkingHours(
  wh: UnipileWorkingHours,
  log: Log,
  now = new Date(),
): WorkingHoursCheck {
  const tz = resolveTimezone(wh.timezone);
  const start = parseHm(wh.start) ?? { h: 9, m: 0 };
  const end = parseHm(wh.end) ?? { h: 18, m: 0 };
  const cur = currentHmInTz(tz, now, log);
  const curMin = cur.h * 60 + cur.m;
  const startMin = start.h * 60 + start.m;
  const endMin = end.h * 60 + end.m;
  const inHourWindow =
    startMin <= endMin
      ? curMin >= startMin && curMin < endMin
      : curMin >= startMin || curMin < endMin;
  const ok = inHourWindow && wh.days.includes(cur.day);
  return {
    ok,
    windowLabel: `${wh.start}–${wh.end} ${tz ?? "system TZ"} on ${formatDays(wh.days)}`,
  };
}

export function minSpacingRemainingSec(
  lastCallAtMs: number | undefined,
  minSpacingSec: number,
  now = Date.now(),
): number {
  if (!minSpacingSec || !lastCallAtMs) return 0;
  const remaining = minSpacingSec - (now - lastCallAtMs) / 1000;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

export function cooldownRemainingSec(
  lastFireMs: number | undefined,
  cooldownSec: number,
  now = Date.now(),
): number {
  if (!cooldownSec || !lastFireMs) return 0;
  const remaining = cooldownSec - (now - lastFireMs) / 1000;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

export function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/**
 * First moment at or after `now` when the working-hours window opens. Null if
 * currently in-window or if no valid minute was found within 8 days (which
 * would imply `days` is empty — the config path should prevent that, but we
 * don't crash on it). Uses minute-granularity search because the window is
 * HH:MM, the weekday filter can create gaps, and analytic math gets ugly for
 * overnight windows in arbitrary TZs.
 */
export function nextWorkingHoursStart(
  wh: UnipileWorkingHours,
  log: Log,
  now = new Date(),
): Date | null {
  if (checkWorkingHours(wh, log, now).ok) return null;
  const stepMs = 60 * 1000;
  const horizon = 8 * 24 * 60; // minutes
  for (let i = 1; i <= horizon; i++) {
    const t = new Date(now.getTime() + i * stepMs);
    if (checkWorkingHours(wh, log, t).ok) return t;
  }
  return null;
}
