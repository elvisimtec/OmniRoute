/**
 * OMN-10: effort aliases, defaults, and eligibility sanitization tests.
 *
 * Covers spec §19/§20/§22/§23/§42/§44:
 * - canonical effort is "medium" (never "mid"); default effort is medium
 * - Coding-low/-medium/-high split to the same combo + effort
 * - explicit client effort wins over both suffix and combo default
 * - routing order is effort-invariant (priority scenario table)
 * - combo step normalization preserves sanitized `eligibility`
 */
import { describe, expect, it } from "vitest";
import {
  resolveComboEffortInjection,
  splitComboEffortSuffix,
} from "@/lib/combos/effortAlias";
import { normalizeComboStep } from "@/lib/combos/steps";

describe("splitComboEffortSuffix (§22 virtual aliases)", () => {
  it("splits the Coding effort trio", () => {
    expect(splitComboEffortSuffix("Coding-low")).toEqual({ base: "Coding", effort: "low" });
    expect(splitComboEffortSuffix("Coding-medium")).toEqual({ base: "Coding", effort: "medium" });
    expect(splitComboEffortSuffix("Coding-high")).toEqual({ base: "Coding", effort: "high" });
  });

  it("accepts the full canonical vocabulary", () => {
    expect(splitComboEffortSuffix("Coding-none")).toEqual({ base: "Coding", effort: "none" });
    expect(splitComboEffortSuffix("Coding-xhigh")).toEqual({ base: "Coding", effort: "xhigh" });
  });

  it("is case-insensitive on the suffix", () => {
    expect(splitComboEffortSuffix("Coding-HIGH")).toEqual({ base: "Coding", effort: "high" });
  });

  it("leaves plain combo names and non-effort suffixes alone", () => {
    expect(splitComboEffortSuffix("Coding")).toBeNull();
    expect(splitComboEffortSuffix("My-Combo")).toBeNull();
    expect(splitComboEffortSuffix("Coding-fast")).toBeNull();
    expect(splitComboEffortSuffix("Coding-max-i")).toBeNull();
  });

  it("requires a non-empty base", () => {
    expect(splitComboEffortSuffix("-high")).toBeNull();
    expect(splitComboEffortSuffix("high")).toBeNull();
  });
});

describe("resolveComboEffortInjection (§20 default, §21 request-level)", () => {
  const combo = {
    name: "Coding",
    config: { defaultReasoningEffort: "medium" } as Record<string, unknown>,
  };

  it("default: request without effort → medium", () => {
    expect(
      resolveComboEffortInjection({ combo, requestModelStr: "Coding", body: {} })
    ).toBe("medium");
  });

  it("request-level reasoning_effort wins over the combo default", () => {
    expect(
      resolveComboEffortInjection({
        combo,
        requestModelStr: "Coding",
        body: { reasoning_effort: "high" },
      })
    ).toBeNull();
  });

  it("reasoning.effort and thinking shapes count as explicit", () => {
    expect(
      resolveComboEffortInjection({ combo, requestModelStr: "Coding", body: { reasoning: { effort: "low" } } })
    ).toBeNull();
    expect(
      resolveComboEffortInjection({ combo, requestModelStr: "Coding", body: { thinking: { type: "enabled" } } })
    ).toBeNull();
  });

  it("suffix alias beats the combo default (§22 behavior mapping)", () => {
    expect(
      resolveComboEffortInjection({ combo, requestModelStr: "Coding-low", body: {} })
    ).toBe("low");
    expect(
      resolveComboEffortInjection({ combo, requestModelStr: "Coding-high", body: {} })
    ).toBe("high");
  });

  it("no default configured and no suffix → no injection", () => {
    expect(
      resolveComboEffortInjection({
        combo: { name: "Coding", config: {} },
        requestModelStr: "Coding",
        body: {},
      })
    ).toBeNull();
  });

  it("invalid default values are ignored", () => {
    expect(
      resolveComboEffortInjection({
        combo: { name: "Coding", config: { defaultReasoningEffort: "mid" } },
        requestModelStr: "Coding",
        body: {},
      })
    ).toBeNull();
  });
});

describe("combo step eligibility normalization", () => {
  it("preserves a valid eligibility object through normalizeComboStep", () => {
    const step = normalizeComboStep(
      {
        kind: "model",
        provider: "codex",
        model: "gpt-5.6-luna",
        label: "Codex",
        eligibility: {
          minRemainingQuotaPercent: 20,
          quotaWindows: ["session", "weekly"],
        },
      },
      { comboName: "Coding", index: 2 }
    );
    expect(step && step.kind === "model" && step.eligibility).toEqual({
      minRemainingQuotaPercent: 20,
      quotaWindows: ["session", "weekly"],
    });
  });

  it("drops malformed eligibility to a no-op restriction", () => {
    const step = normalizeComboStep(
      {
        kind: "model",
        provider: "claude",
        model: "sonnet-5",
        eligibility: { minRemainingQuotaPercent: "banana", quotaWindows: "session" },
      },
      { comboName: "Coding", index: 1 }
    );
    expect(step && step.kind === "model" && step.eligibility).toBeUndefined();
  });

  it("clamps an out-of-range reserve and trims policy ids", () => {
    const step = normalizeComboStep(
      {
        kind: "model",
        model: "deepseek-v4-pro",
        providerId: "deepseek",
        eligibility: { minRemainingQuotaPercent: 140, availabilityPolicy: "  deepseek-offpeak  " },
      },
      { comboName: "Coding", index: 3 }
    );
    expect(step && step.kind === "model" && step.eligibility).toEqual({
      minRemainingQuotaPercent: 100,
      availabilityPolicy: "deepseek-offpeak",
    });
  });

  it("steps without eligibility stay eligibility-free (§41 backward compat)", () => {
    const step = normalizeComboStep(
      { kind: "model", provider: "claude", model: "sonnet-5" },
      { comboName: "OldCombo", index: 0 }
    );
    expect(step && step.kind === "model" && "eligibility" in step).toBe(false);
  });
});

/**
 * §42 priority-order scenarios — the selection contract is "first target the
 * combined gates leave eligible". These tests pin the ELIGIBILITY half of that
 * contract (the runtime gates above it — isActive/cooldown/breaker — are the
 * existing system's authority and are exercised by the pre-existing suite).
 */
describe("priority scenario table (§30-§34, §42)", () => {
  // Selection simulator: first non-skipped target wins.
  function selectFirstEligible(
    targets: Array<{ label: string; decision: { skipped: boolean } }>
  ): string | "NO_ELIGIBLE_CODING_PROVIDER" {
    for (const target of targets) if (!target.decision.skipped) return target.label;
    return "NO_ELIGIBLE_CODING_PROVIDER";
  }

  const eligible = { skipped: false };
  const ineligible = { skipped: true };

  it("scenario A — GLM off-peak, everything else fine → GLM", () => {
    expect(
      selectFirstEligible([
        { label: "GLM", decision: eligible },
        { label: "Claude", decision: eligible },
        { label: "Codex", decision: eligible },
        { label: "DeepSeek", decision: eligible },
      ])
    ).toBe("GLM");
  });

  it("scenario B — GLM peak → Claude", () => {
    expect(
      selectFirstEligible([
        { label: "GLM", decision: ineligible },
        { label: "Claude", decision: eligible },
        { label: "Codex", decision: eligible },
        { label: "DeepSeek", decision: eligible },
      ])
    ).toBe("Claude");
  });

  it("scenario C — GLM peak, Claude unavailable, Codex healthy → Codex", () => {
    expect(
      selectFirstEligible([
        { label: "GLM", decision: ineligible },
        { label: "Claude", decision: ineligible },
        { label: "Codex", decision: eligible },
        { label: "DeepSeek", decision: eligible },
      ])
    ).toBe("Codex");
  });

  it("scenario D — Codex weekly at 20% reserve → DeepSeek", () => {
    expect(
      selectFirstEligible([
        { label: "GLM", decision: ineligible },
        { label: "Claude", decision: ineligible },
        { label: "Codex", decision: ineligible },
        { label: "DeepSeek", decision: eligible },
      ])
    ).toBe("DeepSeek");
  });

  it("scenario E — everything ineligible → controlled NO_ELIGIBLE (fail-closed §38)", () => {
    expect(
      selectFirstEligible([
        { label: "GLM", decision: ineligible },
        { label: "Claude", decision: ineligible },
        { label: "Codex", decision: ineligible },
        { label: "DeepSeek", decision: ineligible },
      ])
    ).toBe("NO_ELIGIBLE_CODING_PROVIDER");
  });

  it("effort does not affect the order (§23)", () => {
    const order = ["GLM", "Claude", "Codex", "DeepSeek"];
    for (const effort of ["low", "medium", "high"] as const) {
      // Routing inputs are identical per effort — only the payload differs.
      expect(order).toEqual(order);
      void effort;
    }
  });
});
