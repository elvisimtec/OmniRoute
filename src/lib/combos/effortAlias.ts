/**
 * OMN-10: combo-level reasoning effort aliases and defaults.
 *
 * A combo can expose effort selection without duplicating the combo: requests
 * for `<combo>-low` / `<combo>-medium` / `<combo>-high` resolve to the SAME
 * combo (same targets, same routing policy) with the effort carried into the
 * request, and a combo can declare a `defaultReasoningEffort` applied when the
 * client sends no reasoning field at all. Effort NEVER changes provider
 * priority — it only controls the reasoning behavior of whichever provider the
 * combo selected (the per-provider payload mapping stays in the existing
 * reasoning translation layer).
 *
 * Pure leaf: no imports, no I/O. Consumers:
 * - src/sse/services/model.ts (getComboForModel) — suffix resolution
 * - src/sse/handlers/chat.ts   — effort injection before combo dispatch
 * - src/app/api/v1/models/catalog.ts — catalog variant entries
 */

/** Canonical internal effort values (spec: canonical is "medium", not "mid"). */
export const COMBO_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh"] as const;

export type ComboEffortValue = (typeof COMBO_EFFORT_VALUES)[number];

/** Effort variants exposed in the model catalog (the UI trio). */
export const COMBO_EFFORT_VARIANT_IDS: ReadonlyArray<ComboEffortValue> = [
  "low",
  "medium",
  "high",
];

/**
 * Split a trailing effort suffix off a combo name: "Coding-high" →
 * { base: "Coding", effort: "high" }. Only an EXACT canonical match on the
 * text after the LAST dash counts, so combo names that merely contain a dash
 * ("My-Combo") resolve unchanged, and literal combo names always win because
 * exact lookup runs before suffix resolution.
 */
export function splitComboEffortSuffix(modelStr: string): {
  base: string;
  effort: ComboEffortValue;
} | null {
  if (typeof modelStr !== "string") return null;
  const trimmed = modelStr.trim();
  const lastDash = trimmed.lastIndexOf("-");
  if (lastDash <= 0 || lastDash >= trimmed.length - 1) return null;
  const suffix = trimmed.slice(lastDash + 1).toLowerCase();
  if (!(COMBO_EFFORT_VALUES as readonly string[]).includes(suffix)) return null;
  return { base: trimmed.slice(0, lastDash), effort: suffix as ComboEffortValue };
}

/** True when the request body already expresses a reasoning-effort choice, in any known shape. */
function hasExplicitReasoningField(body: Record<string, unknown> | null | undefined): boolean {
  if (!body || typeof body !== "object") return false;
  return (
    body.reasoning_effort !== undefined ||
    body.reasoning !== undefined ||
    body.thinking !== undefined
  );
}

/**
 * Resolve the reasoning effort to inject for a combo request, or null when the
 * body must stay untouched. Precedence:
 *   1. explicit client field (any shape) → null (client wins, no injection)
 *   2. `<combo>-<effort>` suffix on the request model (explicit selection)
 *   3. combo `config.defaultReasoningEffort` (operator default)
 */
export function resolveComboEffortInjection(options: {
  combo: { name?: string; config?: Record<string, unknown> | null } | null | undefined;
  requestModelStr: string | null | undefined;
  body: Record<string, unknown> | null | undefined;
}): ComboEffortValue | null {
  const { combo, requestModelStr, body } = options;
  if (!combo) return null;
  if (hasExplicitReasoningField(body)) return null;

  if (requestModelStr) {
    const split = splitComboEffortSuffix(requestModelStr);
    if (split && split.base !== requestModelStr.trim()) return split.effort;
  }

  const fallback = combo.config?.defaultReasoningEffort;
  if (
    typeof fallback === "string" &&
    (COMBO_EFFORT_VALUES as readonly string[]).includes(fallback)
  ) {
    return fallback as ComboEffortValue;
  }
  return null;
}
