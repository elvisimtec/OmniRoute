/**
 * OMN-10: combo-step eligibility evaluator tests.
 *
 * Covers the spec boundary semantics:
 * - quota reserve: 20.01% → eligible, 20.00% → ineligible, 19.99% → ineligible
 * - window scoping: session only / weekly only / both (spec §43)
 * - missing window data is ignored, never failed (spec §12)
 * - schedule policies: settings override builtins, builtin deepseek-offpeak
 *   honored, unconfigured ids fail CLOSED (spec §8.3 + §38)
 * - quota fetch errors fail OPEN (same posture as the existing cutoff)
 * - eligibility without restrictions is a no-op
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// The evaluator resolves the connection through localDb and quota through the
// reset-aware cache — replace both with controllable fakes for unit scope.
vi.mock("@/lib/localDb", () => ({
  getCachedProviderConnectionById: vi.fn(async () => ({ id: "conn-1" })),
}));

const fakeQuota = { value: null as unknown };
vi.mock("@omniroute/open-sse/services/combo/quotaStrategies.ts", () => ({
  fetchResetAwareQuotaWithCache: vi.fn(async () => fakeQuota.value),
}));

// No provider executors are loaded in unit scope, so the quota-fetcher
// registry is empty — stub a fetcher for every provider (keep the rest of the
// real quotaPreflight module so cutoff semantics stay importable).
vi.mock("@omniroute/open-sse/services/quotaPreflight.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omniroute/open-sse/services/quotaPreflight.ts")>();
  return {
    ...actual,
    getQuotaFetcher: vi.fn(() => async () => fakeQuota.value as never),
  };
});

import { evaluateStepQuotaEligibility } from "@omniroute/open-sse/services/combo/stepEligibility.ts";
import { resolveStepEligibilitySkipForTarget } from "@omniroute/open-sse/services/combo/stepEligibility.ts";
import type { QuotaInfo } from "@omniroute/open-sse/services/quotaPreflight.ts";
import type { ResilienceSettings } from "@/lib/resilience/settings";

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} };
const resetConfig = { quotaCacheTtlMs: 0, quotaCacheMaxStaleMs: 0 } as never;

function quotaWithWindows(
  windows: Record<string, { percentUsed: number; resetAt?: string | null }>
): QuotaInfo {
  return { used: 0, total: 0, percentUsed: 0, windows };
}

/** Codex-style fetcher windows: percentUsed is a 0..1 fraction. */
function codexQuota(sessionUsedFraction: number, weeklyUsedFraction: number): QuotaInfo {
  return quotaWithWindows({
    session: { percentUsed: sessionUsedFraction },
    weekly: { percentUsed: weeklyUsedFraction },
  });
}

const baseArgs = {
  provider: "codex",
  connectionId: "conn-1",
  resilienceSettings: null,
  resetWindowConfig: resetConfig,
  comboName: "Coding",
  log: silentLog,
};

describe("quota reserve boundary (spec §11/§43)", () => {
  it("20.01% remaining → eligible", () => {
    const verdict = evaluateStepQuotaEligibility(
      quotaWithWindows({ session: { percentUsed: 0.7999 } }),
      "codex",
      { minRemainingQuotaPercent: 20 }
    );
    expect(verdict.eligible).toBe(true);
  });

  it("20.00% remaining → ineligible", () => {
    const verdict = evaluateStepQuotaEligibility(
      quotaWithWindows({ session: { percentUsed: 0.8 } }),
      "codex",
      { minRemainingQuotaPercent: 20 }
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.detail).toContain("session");
  });

  it("19.99% remaining → ineligible", () => {
    const verdict = evaluateStepQuotaEligibility(
      quotaWithWindows({ session: { percentUsed: 0.8001 } }),
      "codex",
      { minRemainingQuotaPercent: 20 }
    );
    expect(verdict.eligible).toBe(false);
  });

  it("session 73% / weekly 46% → eligible (scenario C)", () => {
    const verdict = evaluateStepQuotaEligibility(codexQuota(0.27, 0.54), "codex", {
      minRemainingQuotaPercent: 20,
      quotaWindows: ["session", "weekly"],
    });
    expect(verdict.eligible).toBe(true);
  });

  it("session 80% / weekly 80% (both below reserve) → ineligible (scenario D-ish)", () => {
    const verdict = evaluateStepQuotaEligibility(codexQuota(0.8, 0.8), "codex", {
      minRemainingQuotaPercent: 20,
      quotaWindows: ["session", "weekly"],
    });
    expect(verdict.eligible).toBe(false);
  });

  it("any single exhausted window blocks (5h 65%, weekly 19% → SKIP per spec §11)", () => {
    const verdict = evaluateStepQuotaEligibility(codexQuota(0.35, 0.81), "codex", {
      minRemainingQuotaPercent: 20,
      quotaWindows: ["session", "weekly"],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.detail).toContain("weekly");
  });

  it("window aliasing: '5h' and '7d' names resolve for codex", () => {
    const quota = quotaWithWindows({
      session: { percentUsed: 0.1 },
      weekly: { percentUsed: 0.81 },
    });
    expect(
      evaluateStepQuotaEligibility(quota, "codex", {
        minRemainingQuotaPercent: 20,
        quotaWindows: ["5h", "7d"],
      }).eligible
    ).toBe(false);
  });

  it("requested window without data is ignored, not failed (spec §12)", () => {
    const verdict = evaluateStepQuotaEligibility(codexQuota(0.1, 1), "codex", {
      minRemainingQuotaPercent: 20,
      quotaWindows: ["session", "monthly"],
    });
    // monthly has no data → ignored; session at 90% remaining → eligible.
    expect(verdict.eligible).toBe(true);
  });

  it("limitReached blocks regardless of numbers", () => {
    const verdict = evaluateStepQuotaEligibility(
      { ...codexQuota(0.1, 0.1), limitReached: true },
      "codex",
      { minRemainingQuotaPercent: 20 }
    );
    expect(verdict.eligible).toBe(false);
  });

  it("no quota snapshot → eligible (nothing to enforce)", () => {
    expect(
      evaluateStepQuotaEligibility(null, "codex", { minRemainingQuotaPercent: 20 }).eligible
    ).toBe(true);
  });

  it("single-signal quota (no windows) uses overall percentUsed", () => {
    const quota: QuotaInfo = { used: 95, total: 100, percentUsed: 0.95 };
    expect(
      evaluateStepQuotaEligibility(quota, "codex", { minRemainingQuotaPercent: 20 }).eligible
    ).toBe(false);
    expect(
      evaluateStepQuotaEligibility({ ...quota, percentUsed: 0.5 }, "codex", {
        minRemainingQuotaPercent: 20,
      }).eligible
    ).toBe(true);
  });
});

describe("schedule policy resolution via resolveStepEligibilitySkipForTarget", () => {
  beforeEach(() => {
    fakeQuota.value = null;
  });

  it("no eligibility → never skipped", async () => {
    const decision = await resolveStepEligibilitySkipForTarget({ ...baseArgs });
    expect(decision).toEqual({ skipped: false });
  });

  it("unconfigured policy id → fail-closed eligibility_policy", async () => {
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      eligibility: { availabilityPolicy: "zai-offpeak" },
      resilienceSettings: { availabilityPolicies: [] } as unknown as ResilienceSettings,
    });
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("eligibility_policy");
  });

  it("configured policy inside its window → eligible", async () => {
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      eligibility: { availabilityPolicy: "zai-offpeak" },
      resilienceSettings: {
        availabilityPolicies: [
          {
            id: "zai-offpeak",
            timezone: "UTC",
            windows: [{ start: "00:00", end: "24:00" }],
          },
        ],
      } as unknown as ResilienceSettings,
      now: new Date(Date.UTC(2026, 8, 7, 3, 0)),
    });
    expect(decision.skipped).toBe(false);
  });

  it("configured policy outside its window → peak_period", async () => {
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      eligibility: { availabilityPolicy: "zai-offpeak" },
      resilienceSettings: {
        availabilityPolicies: [
          { id: "zai-offpeak", timezone: "UTC", windows: [{ start: "22:00", end: "23:00" }] },
        ],
      } as unknown as ResilienceSettings,
      now: new Date(Date.UTC(2026, 8, 7, 3, 0)),
    });
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("peak_period");
  });

  it("builtin deepseek-offpeak is honored with no configuration (off-peak instant)", async () => {
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      provider: "deepseek",
      eligibility: { availabilityPolicy: "deepseek-offpeak" },
      now: new Date(Date.UTC(2026, 8, 12, 8, 0)), // Saturday → off-peak
    });
    expect(decision.skipped).toBe(false);
  });

  it("builtin deepseek-offpeak blocks during peak (Monday 02:00)", async () => {
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      provider: "deepseek",
      eligibility: { availabilityPolicy: "deepseek-offpeak" },
      now: new Date(Date.UTC(2026, 8, 7, 2, 0)),
    });
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("peak_period");
  });

  it("quota reserve below the line → quota_reserve skip", async () => {
    fakeQuota.value = codexQuota(0.27, 0.81); // weekly 19% remaining
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      eligibility: { minRemainingQuotaPercent: 20, quotaWindows: ["session", "weekly"] },
      now: new Date(Date.UTC(2026, 8, 7, 2, 0)),
    });
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("quota_reserve");
  });

  it("quota reserve above the line → eligible", async () => {
    fakeQuota.value = codexQuota(0.27, 0.54);
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      eligibility: { minRemainingQuotaPercent: 20, quotaWindows: ["session", "weekly"] },
    });
    expect(decision.skipped).toBe(false);
  });

  it("quota fetch failure fails OPEN (routing not broken by usage-endpoint outage)", async () => {
    const { fetchResetAwareQuotaWithCache } = await import(
      "@omniroute/open-sse/services/combo/quotaStrategies.ts"
    );
    (fetchResetAwareQuotaWithCache as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("usage endpoint down")
    );
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      eligibility: { minRemainingQuotaPercent: 20 },
    });
    expect(decision.skipped).toBe(false);
  });

  it("combined schedule + quota: schedule gate runs first and short-circuits", async () => {
    fakeQuota.value = codexQuota(0.99, 0.99);
    const decision = await resolveStepEligibilitySkipForTarget({
      ...baseArgs,
      provider: "deepseek",
      eligibility: { availabilityPolicy: "deepseek-offpeak", minRemainingQuotaPercent: 20 },
      now: new Date(Date.UTC(2026, 8, 7, 2, 0)), // peak → skip before quota I/O matters
    });
    expect(decision.reason).toBe("peak_period");
  });
});
