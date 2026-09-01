/**
 * OMN-10: per-combo-step eligibility filter, evaluated BEFORE dispatch inside
 * the existing combo fallback loop (combo.ts::executeTarget and the
 * round-robin rotation loop).
 *
 * Concept (REQ-001 / GitHub issue #10): a combo step can carry an optional
 * `eligibility` object —
 *
 *   { availabilityPolicy?: string,                  // named schedule policy
 *     minRemainingQuotaPercent?: number,            // hard quota reserve (%)
 *     quotaWindows?: string[] }                     // which windows to check
 *
 * Eligibility only ever NARROWS availability. It runs AFTER the built-in
 * gates (active connection, persisted cooldown, circuit breaker, model
 * lockout), so it can never re-activate a target the rest of the system
 * already marked unavailable. A skipped target is a plain "continue to the
 * next priority target" — no administrative state (connection `isActive`,
 * cooldowns, breaker counters) is written.
 *
 * Sources of truth:
 * - Schedule policies: resilience settings `availabilityPolicies` (operator
 *   configured, e.g. `zai-offpeak`) overriding built-ins
 *   (`deepseek-offpeak`, deterministic UTC — see availabilitySchedule.ts).
 *   The zcode provider exposes no runtime off-peak/plan signal in v3.8.50,
 *   so a configured schedule IS the source of truth there (spec §8.3).
 * - Quota: the SAME fetchers and reset-aware cache the existing quota
 *   exhaustion cutoff uses (`fetchResetAwareQuotaWithCache` +
 *   `evaluateQuotaCutoff` semantics); this module never duplicates the quota
 *   engine, only scopes the comparison to the step's reserve/windows.
 *
 * Failure posture: schedule evaluation is fail-CLOSED (unresolvable policy id
 * or unknown timezone => target ineligible); quota FETCHING is fail-open on
 * transport errors (same as the existing cutoff) because a transient usage
 * endpoint outage must not take the whole chain down. Boundary semantics:
 * a window is blocked when remaining <= reserve% (+ epsilon), so a 20%
 * reserve makes 20.01% eligible and 20.00% ineligible.
 *
 * Pure leaf: never imports from the combo barrel (only sibling leaves),
 * records nothing, mutates nothing.
 */
import {
  getQuotaFetcher,
  type QuotaInfo,
} from "../quotaPreflight.ts";
import { getCachedProviderConnectionById } from "@/lib/db/readCache";
import {
  resolveResilienceSettings,
  type ResilienceSettings,
} from "../../../src/lib/resilience/settings";
import type { ComboStepEligibility } from "../../../src/lib/combos/steps.ts";
import { fetchResetAwareQuotaWithCache } from "./quotaStrategies.ts";
import type { ResetWindowConfig } from "./quotaScoring.ts";
import { quotaWindowLookupNames } from "./quotaExhaustionCutoff.ts";
import {
  BUILTIN_AVAILABILITY_POLICIES,
  evaluateSchedulePolicy,
  type SchedulePolicy,
} from "./availabilitySchedule.ts";

/** Allowlisted skip reasons (COMBO_SKIP_REASONS in decisionTrace.ts). */
export type StepEligibilitySkipReason = "peak_period" | "quota_reserve" | "eligibility_policy";

export interface StepEligibilityDecision {
  skipped: boolean;
  reason?: StepEligibilitySkipReason;
  /** Human-readable, secret-free detail for logs/diag (provider ids and percentages only). */
  detail?: string;
}

const REMAINING_PERCENT_EPSILON = 1e-9;

function remainingPercentFrom(percentUsed: number): number {
  return Math.max(0, (1 - percentUsed) * 100);
}

// One warn per unconfigured policy id per process — dispatch-time checks run
// per request, and the operator only needs to see this once.
const warnedPolicyIds = new Set<string>();
function warnPolicyOnce(policyId: string, log: StepEligibilityLog): void {
  if (warnedPolicyIds.has(policyId) || warnedPolicyIds.size > 200) return;
  warnedPolicyIds.add(policyId);
  log.warn?.(
    "COMBO",
    `Eligibility availabilityPolicy "${policyId}" is not configured (resilience settings availabilityPolicies) — targets referencing it are ineligible (fail-closed)`
  );
}

export interface StepEligibilityLog {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Pure quota-reserve evaluation for a fetched quota snapshot. Mirrors
 * evaluateQuotaCutoff's "minimum remaining %" semantics, scoped to the step's
 * windows:
 * - requested windows with NO runtime data are ignored (never fail);
 * - with no quotaWindows restriction, every window the fetcher exposed is
 *   checked (plus the legacy single-signal percentUsed fallback).
 */
export function evaluateStepQuotaEligibility(
  quota: QuotaInfo | null | undefined,
  provider: string,
  eligibility: { minRemainingQuotaPercent?: number; quotaWindows?: string[] }
): { eligible: boolean; detail?: string } {
  const reserve = eligibility.minRemainingQuotaPercent;
  if (typeof reserve !== "number" || !Number.isFinite(reserve)) return { eligible: true };
  if (!quota) return { eligible: true };

  if (quota.limitReached === true) {
    return {
      eligible: false,
      detail: `quota limit reached (reserve ${reserve}%)`,
    };
  }

  const windows = quota.windows;
  if (windows && Object.keys(windows).length > 0) {
    const requested =
      eligibility.quotaWindows && eligibility.quotaWindows.length > 0
        ? eligibility.quotaWindows
        : Object.keys(windows);
    for (const requestedName of requested) {
      let matchedName: string | null = null;
      if (windows[requestedName]) matchedName = requestedName;
      else {
        for (const lookupName of quotaWindowLookupNames(provider, requestedName)) {
          if (windows[lookupName]) {
            matchedName = lookupName;
            break;
          }
        }
      }
      // Missing window data: ignore this window (spec §12 — only ACTIVE
      // windows with data participate).
      if (!matchedName) continue;
      const percentUsed = windows[matchedName].percentUsed;
      if (!Number.isFinite(percentUsed)) continue;
      const remaining = remainingPercentFrom(percentUsed);
      if (remaining <= reserve + REMAINING_PERCENT_EPSILON) {
        return {
          eligible: false,
          detail: `${matchedName} remaining ${remaining.toFixed(2)}% <= reserve ${reserve}%`,
        };
      }
    }
    return { eligible: true };
  }

  if (!Number.isFinite(quota.percentUsed)) return { eligible: true };
  const remaining = remainingPercentFrom(quota.percentUsed);
  return remaining <= reserve + REMAINING_PERCENT_EPSILON
    ? {
        eligible: false,
        detail: `remaining ${remaining.toFixed(2)}% <= reserve ${reserve}%`,
      }
    : { eligible: true };
}

/**
 * Resolve the schedule-policy part of a step's eligibility. Fail-closed:
 * unknown policy ids make the target ineligible.
 */
function resolveScheduleSkip(
  policyId: string,
  resilienceSettings: ResilienceSettings | null | undefined,
  now: Date,
  log: StepEligibilityLog
): StepEligibilityDecision {
  const configured = resolveResilienceSettings(null)?.availabilityPolicies ?? [];
  const fromSettings = resilienceSettings?.availabilityPolicies ?? configured;
  const policy = fromSettings.find((entry) => entry && entry.id === policyId);

  if (policy) {
    const outcome = evaluateSchedulePolicy(policy as SchedulePolicy, now);
    if (outcome === "in_window") return { skipped: false };
    if (outcome === "unknown") {
      warnPolicyOnce(`${policyId} (invalid schedule)`, log);
      return {
        skipped: true,
        reason: "eligibility_policy",
        detail: `availability policy "${policyId}" has an invalid timezone/window definition`,
      };
    }
    return { skipped: true, reason: "peak_period", detail: `availability policy "${policyId}" out of window` };
  }

  const builtin = BUILTIN_AVAILABILITY_POLICIES[policyId];
  if (builtin) {
    return builtin(now)
      ? { skipped: false }
      : { skipped: true, reason: "peak_period", detail: `builtin availability policy "${policyId}" out of window` };
  }

  warnPolicyOnce(policyId, log);
  return {
    skipped: true,
    reason: "eligibility_policy",
    detail: `availability policy "${policyId}" is not configured`,
  };
}

/**
 * Full per-target eligibility resolution for combo dispatch. Returns
 * `{ skipped: true, reason, detail }` when the target must be passed over.
 * `now` is injectable for deterministic tests.
 */
export async function resolveStepEligibilitySkipForTarget(options: {
  provider: string;
  connectionId: string | null | undefined;
  eligibility: ComboStepEligibility | null | undefined;
  resilienceSettings: ResilienceSettings | null | undefined;
  resetWindowConfig: ResetWindowConfig;
  comboName: string;
  log: StepEligibilityLog;
  now?: Date;
}): Promise<StepEligibilityDecision> {
  const { provider, connectionId, eligibility, resilienceSettings, resetWindowConfig, comboName, log } =
    options;
  const now = options.now ?? new Date();
  if (!eligibility || typeof eligibility !== "object") return { skipped: false };

  // 1. Schedule policy (cheap, deterministic — no I/O).
  if (eligibility.availabilityPolicy) {
    const scheduleSkip = resolveScheduleSkip(
      eligibility.availabilityPolicy,
      resilienceSettings,
      now,
      log
    );
    if (scheduleSkip.skipped) return scheduleSkip;
  }

  // 2. Quota reserve — reuse the existing quota fetchers + reset-aware cache.
  const reserve = eligibility.minRemainingQuotaPercent;
  if (typeof reserve !== "number" || !Number.isFinite(reserve)) return { skipped: false };
  if (!provider || !connectionId) return { skipped: false };

  const fetcher = getQuotaFetcher(provider);
  // No fetcher for this provider => no quota data exists to enforce; the step
  // restriction simply has nothing to narrow (spec §12: don't fail on absent
  // windows).
  if (!fetcher) return { skipped: false };

  let connection: Record<string, unknown> | undefined;
  try {
    connection = (await getCachedProviderConnectionById(connectionId)) as
      | Record<string, unknown>
      | undefined;
  } catch {
    connection = undefined;
  }

  try {
    const quota = await fetchResetAwareQuotaWithCache({
      provider,
      connectionId,
      connection,
      fetcher,
      config: resetWindowConfig,
      log,
      comboName,
    });
    const verdict = evaluateStepQuotaEligibility(quota as QuotaInfo | null, provider, eligibility);
    if (!verdict.eligible) {
      return { skipped: true, reason: "quota_reserve", detail: verdict.detail };
    }
    return { skipped: false };
  } catch {
    // Fail-open on fetch errors, identical to the existing quota cutoff:
    // a usage-endpoint outage must not break routing.
    log.warn?.("COMBO", `Eligibility quota fetch failed for ${provider}:${connectionId} — failing open`);
    return { skipped: false };
  }
}
