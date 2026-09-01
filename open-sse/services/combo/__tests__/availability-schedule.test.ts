/**
 * OMN-10: deterministic availability-schedule tests.
 *
 * - DeepSeek peak/off-peak boundary table straight from the spec (section 17),
 *   evaluated with FIXED UTC Date objects so the suite never depends on the
 *   CI host's timezone.
 * - Configurable schedule policy evaluation (timezone windows, weekday
 *   filters, midnight wrap, fail-closed on unknown timezone).
 */
import { describe, expect, it } from "vitest";
import {
  evaluateSchedulePolicy,
  isDeepSeekOffPeak,
  isDeepSeekPeak,
  localTimeInTimezone,
  type SchedulePolicy,
} from "@omniroute/open-sse/services/combo/availabilitySchedule.ts";

/** Build a fixed UTC instant from a 1-BASED month: `utc(2026, 9, 7, 1, 0)` = 2026-09-07T01:00:00Z. */
function utc(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0
): Date {
  return new Date(Date.UTC(year, month1 - 1, day, hour, minute, second));
}

// 2026-09-07 is a Monday, 2026-09-12 Saturday, 2026-09-13 Sunday.
const MON = { y: 2026, m: 9, d: 7 };
const SAT = { y: 2026, m: 9, d: 12 };
const SUN = { y: 2026, m: 9, d: 13 };

describe("DeepSeek peak/off-peak boundary table (spec §17)", () => {
  const cases: Array<{ label: string; h: number; min: number; day: typeof MON; peak: boolean }> = [
    { label: "Monday 00:59 UTC → off-peak", h: 0, min: 59, day: MON, peak: false },
    { label: "Monday 01:00 UTC → peak", h: 1, min: 0, day: MON, peak: true },
    { label: "Monday 03:59 UTC → peak", h: 3, min: 59, day: MON, peak: true },
    { label: "Monday 04:00 UTC → off-peak", h: 4, min: 0, day: MON, peak: false },
    { label: "Monday 05:59 UTC → off-peak", h: 5, min: 59, day: MON, peak: false },
    { label: "Monday 06:00 UTC → peak", h: 6, min: 0, day: MON, peak: true },
    { label: "Monday 09:59 UTC → peak", h: 9, min: 59, day: MON, peak: true },
    { label: "Monday 10:00 UTC → off-peak", h: 10, min: 0, day: MON, peak: false },
    { label: "Saturday 03:00 UTC → off-peak", h: 3, min: 0, day: SAT, peak: false },
    { label: "Saturday 08:00 UTC → off-peak", h: 8, min: 0, day: SAT, peak: false },
    { label: "Sunday 08:00 UTC → off-peak", h: 8, min: 0, day: SUN, peak: false },
    // Extras: sharp Friday edge before the weekend, and exact window starts.
    { label: "Friday 09:59 UTC → peak", h: 9, min: 59, day: { y: 2026, m: 9, d: 11 }, peak: true },
    { label: "Friday 23:59 UTC → off-peak", h: 23, min: 59, day: { y: 2026, m: 9, d: 11 }, peak: false },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const now = utc(c.day.y, c.day.m, c.day.d, c.h, c.min);
      expect(isDeepSeekPeak(now)).toBe(c.peak);
      expect(isDeepSeekOffPeak(now)).toBe(!c.peak);
    });
  }

  it("defaults to the current time (smoke)", () => {
    expect(typeof isDeepSeekPeak()).toBe("boolean");
    expect(isDeepSeekOffPeak()).toBe(!isDeepSeekPeak());
  });
});

describe("configurable schedule policies", () => {
  it("resolves wall-clock time in an IANA timezone", () => {
    // 2026-09-07T18:30:00Z is 2026-09-08 02:30 in Asia/Shanghai (UTC+8) — Tuesday.
    const local = localTimeInTimezone(utc(2026, 9, 7, 18, 30), "Asia/Shanghai");
    expect(local).toEqual({ weekday: 2, minutes: 150 });
    // 2026-09-07T16:30:00Z is 2026-09-08 00:30 in Asia/Shanghai — Tuesday 00:30.
    const early = localTimeInTimezone(utc(2026, 9, 7, 16, 30), "Asia/Shanghai");
    expect(early).toEqual({ weekday: 2, minutes: 30 });
  });

  it("matches a Shanghai off-peak window and rejects outside it", () => {
    const policy: SchedulePolicy = {
      id: "zai-offpeak",
      timezone: "Asia/Shanghai",
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:30", end: "08:30" }],
    };
    // 00:30 sharp Shanghai → in window.
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 16, 30))).toBe("in_window");
    // 00:29 Shanghai → out.
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 16, 29))).toBe("out_window");
    // 08:30 sharp Shanghai → out (half-open window).
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 8, 0, 30))).toBe("out_window");
  });

  it("honors weekday filters in the policy timezone", () => {
    const policy: SchedulePolicy = {
      id: "weekends-only",
      timezone: "UTC",
      windows: [{ days: [0, 6], start: "00:00", end: "24:00" }],
    };
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 12, 12, 0))).toBe("in_window"); // Saturday
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 13, 12, 0))).toBe("in_window"); // Sunday
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 12, 0))).toBe("out_window"); // Monday
  });

  it("supports windows that wrap midnight", () => {
    const policy: SchedulePolicy = {
      id: "night-owl",
      windows: [{ start: "22:00", end: "06:00" }],
    };
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 23, 0))).toBe("in_window");
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 3, 0))).toBe("in_window");
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 12, 0))).toBe("out_window");
  });

  it("is fail-closed on an unknown timezone", () => {
    const policy: SchedulePolicy = {
      id: "bad-tz",
      timezone: "Mars/Olympus",
      windows: [{ start: "00:00", end: "24:00" }],
    };
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 12, 0))).toBe("unknown");
  });

  it("defaults to UTC when no timezone is set", () => {
    const policy: SchedulePolicy = { id: "utc-window", windows: [{ start: "10:00", end: "12:00" }] };
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 11, 59))).toBe("in_window");
    expect(evaluateSchedulePolicy(policy, utc(2026, 9, 7, 12, 0))).toBe("out_window");
  });
});
