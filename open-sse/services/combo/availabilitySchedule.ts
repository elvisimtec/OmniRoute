/**
 * OMN-10: deterministic time-window availability helpers for combo-step
 * eligibility (open-sse/services/combo/stepEligibility.ts).
 *
 * Two layers:
 *
 * 1. Built-in policies — currently only `deepseek-offpeak`, implemented as the
 *    pure UTC functions `isDeepSeekPeak` / `isDeepSeekOffPeak`. DeepSeek's
 *    official off-peak discount windows are timezone-fixed and do not need a
 *    config surface: peak is Monday-Friday 01:00-04:00 and 06:00-10:00 UTC;
 *    Saturday and Sunday are off-peak all day. Window bounds are half-open
 *    [start, end) so 01:00:00.000 sharp is already peak and 00:59:59.999 is
 *    not (matches the OMN-10 boundary test table).
 *
 * 2. Configurable policies — `scheduleWindowMatches` evaluates operator-defined
 *    `availabilityPolicies` entries from resilience settings (id, IANA
 *    timezone, windows) using Intl, so a deployment can express e.g. the
 *    Z.ai Coding Plan off-peak hours (`zai-offpeak`, `Asia/Shanghai`) without
 *    code changes. The zcode provider exposes no runtime off-peak signal in
 *    v3.8.50, which is why the schedule fallback is the source of truth there.
 *
 * Pure leaf: no imports from the combo barrel, no I/O, no module state.
 */

/** Minutes since midnight in [start, end) form. */
export interface ScheduleWindow {
  /** Weekdays 0=Sunday..6=Saturday in the policy timezone. Omit = every day. */
  days?: number[];
  /** Inclusive start "HH:MM". */
  start: string;
  /** Exclusive end "HH:MM"; "24:00" means end-of-day. */
  end: string;
}

export interface SchedulePolicy {
  id: string;
  timezone?: string;
  windows: ScheduleWindow[];
}

// DeepSeek official discount schedule (UTC): peak = Mon-Fri 01:00-04:00 and
// 06:00-10:00. Half-open bounds so the boundary minutes land exactly as the
// OMN-10 test table specifies.
export const DEEPSEEK_PEAK_WINDOWS_UTC: ReadonlyArray<{ start: number; end: number }> = [
  { start: 60, end: 240 }, // 01:00 - 04:00
  { start: 360, end: 600 }, // 06:00 - 10:00
];

export function isDeepSeekPeak(now: Date = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false; // Saturday/Sunday: never peak
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return DEEPSEEK_PEAK_WINDOWS_UTC.some((w) => minutes >= w.start && minutes < w.end);
}

export function isDeepSeekOffPeak(now: Date = new Date()): boolean {
  return !isDeepSeekPeak(now);
}

/**
 * Built-in availability policies. Settings-defined policies with the same id
 * take precedence (see stepEligibility.ts), so an operator can correct the
 * DeepSeek schedule without a code change.
 */
export const BUILTIN_AVAILABILITY_POLICIES: Readonly<
  Record<string, (now: Date) => boolean>
> = {
  "deepseek-offpeak": isDeepSeekOffPeak,
};

function parseClockHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  // "24:00" is allowed as an exclusive end-of-day marker.
  if (hours === 24) return minutes === 0 ? 1440 : null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Resolve a Date into a weekday + minutes-since-midnight in an IANA timezone.
 * Returns null when the timezone name is unknown to the host (fail-closed at
 * the caller) or the Intl output is unexpected.
 */
export function localTimeInTimezone(
  date: Date,
  timezone: string
): { weekday: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    let weekday: number | null = null;
    let hours: number | null = null;
    let minutes: number | null = null;
    for (const part of parts) {
      if (part.type === "weekday") weekday = WEEKDAY_INDEX[part.value] ?? null;
      else if (part.type === "hour") hours = Number(part.value);
      else if (part.type === "minute") minutes = Number(part.value);
    }
    if (weekday === null || hours === null || minutes === null) return null;
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return { weekday, minutes: hours * 60 + minutes };
  } catch {
    return null;
  }
}

/**
 * True when ANY of the policy windows matches `local` (weekday + wall-clock).
 * Windows are half-open [start, end); a start>end window wraps midnight.
 */
export function scheduleWindowMatches(
  windows: ReadonlyArray<ScheduleWindow>,
  local: { weekday: number; minutes: number }
): boolean {
  for (const window of windows) {
    const start = parseClockHHMM(window.start);
    const end = window.end != null ? parseClockHHMM(window.end) : null;
    if (start === null || end === null) continue;
    if (window.days && !window.days.includes(local.weekday)) continue;
    const inWindow =
      start <= end ? local.minutes >= start && local.minutes < end : start > end ? (local.minutes >= start || local.minutes < end) : false;
    if (inWindow) return true;
  }
  return false;
}

/**
 * Evaluate a configured schedule policy at `now`. Returns:
 * - "in_window"  — the policy matched (target may proceed to remaining checks)
 * - "out_window" — policy resolved but `now` is outside every window
 * - "unknown"    — timezone/window malformed or unknown timezone (fail-closed)
 */
export function evaluateSchedulePolicy(
  policy: SchedulePolicy,
  now: Date
): "in_window" | "out_window" | "unknown" {
  const timezone = policy.timezone && policy.timezone.trim() !== "" ? policy.timezone.trim() : "UTC";
  const local = localTimeInTimezone(now, timezone);
  if (!local) return "unknown";
  if (scheduleWindowMatches(policy.windows ?? [], local)) return "in_window";
  return "out_window";
}
