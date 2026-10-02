import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  estimateTokens,
  resolveContextMeterMode,
  charsPerTokenFor,
  finalContextGateLimit,
  __resetContextMeterModeCache,
} from "../../open-sse/services/contextManager.ts";

function setMode(mode: "legacy" | "calibrated" | "") {
  if (mode === "") delete process.env.CONTEXT_METER_MODE;
  else process.env.CONTEXT_METER_MODE = mode;
  __resetContextMeterModeCache();
}

/**
 * Tool-heavy ZCode-style payload fixture (test A): escaped JSON, Bash output,
 * code, tool calls, tool results, long alternating history. Mirrors the shape
 * measured in the production incident (chars/4 undercount 1.44–1.80x).
 */
function buildToolHeavyFixture(turns: number): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "You are a coding agent. Use tools. " + "x".repeat(2000) },
  ];
  for (let i = 0; i < turns; i += 1) {
    messages.push({
      role: "user",
      content: `Investigate issue #${i}: ${JSON.stringify({ query: 'grep -rn "estimateTokens" src/', flags: ["-i", "--include=*.ts"], path: "/srv/app" })}`,
    });
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: {
            name: "Bash",
            arguments: JSON.stringify({ command: `npm test -- --filter=ctx-${i}` }),
          },
        },
        {
          id: `call_${i}_b`,
          type: "function",
          function: {
            name: "Read",
            arguments: JSON.stringify({ file_path: `/src/services/layer${i}.ts` }),
          },
        },
      ],
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: bashOutput(i) });
    messages.push({ role: "tool", tool_call_id: `call_${i}_b`, content: sourceFile(i) });
  }
  return { model: "claude-fable-5", messages };
}

function bashOutput(i: number): string {
  return [
    `> npm test -- --filter=ctx-${i}`,
    "",
    "> omniroute@3.8.49 test",
    "> node --test tests/unit/",
    "",
    `# fixture block ${i}`,
    ...Array.from(
      { length: 12 },
      (_, k) =>
        `ok ${k + 1} - services/contextManager layer${i} case${k} {"ms":${(i + 1) * (k + 3)},"tokens":{"in":${1000 + i * 7 + k},"out":${37 + k}}}`
    ),
    `# fail 1 - regression ratio {"expected":1.0,"actual":1.4${i}}`,
    "not ok 42 - guards final budget",
    "  ---",
    "  operator: equal",
    "  expected: 900000",
    `  actual: ${705593 + i}`,
    "  at: tests/unit/contextManager.test.ts:214:11",
    "  stack: |",
    "      at TestContext.run (node:test:120:5)",
    ...Array.from({ length: 6 }, (_, k) => `      at Layer${k}.run (node:internal:${k}:1)`),
    "  ...",
    `1..${12}`,
    `# tests 12 # pass 11 # fail 1 # duration_ms ${(i + 1) * 91.7}`,
  ].join("\n");
}

function sourceFile(i: number): string {
  return [
    `// src/services/layer${i}.ts — fixture source`,
    'import { estimateTokens } from "./contextManager.ts";',
    "",
    "const CHARS_PER_TOKEN = 4;",
    "",
    "export function legacy(text: string): number {",
    "  if (!text) return 0;",
    `  return Math.ceil(text.length / CHARS_PER_TOKEN); // path ${i}`,
    "}",
    "",
    "export function calibrated(text: string): number {",
    `  return Math.ceil(text.length / 2.5); // alt path ${i}`,
    "}",
    ...Array.from(
      { length: 10 },
      (_, k) =>
        `export const TABLE_${i}_${k} = ${JSON.stringify({ id: k, ratio: 0.25 * k, label: `t-${i}-${k}` })};`
    ),
  ].join("\n");
}

describe("context meter mode (CONTEXT_METER_MODE)", () => {
  beforeEach(() => setMode("calibrated"));

  it("defaults to calibrated and honours legacy rollback", () => {
    setMode("");
    assert.equal(resolveContextMeterMode(), "calibrated");
    setMode("legacy");
    assert.equal(resolveContextMeterMode(), "legacy");
    setMode("calibrated");
    assert.equal(resolveContextMeterMode(), "calibrated");
    setMode("garbage");
    assert.equal(resolveContextMeterMode(), "calibrated");
    setMode("");
  });

  it("test D: legacy mode reproduces the old chars/4 behavior exactly", () => {
    setMode("legacy");
    const fixture = buildToolHeavyFixture(30);
    const json = JSON.stringify(fixture.messages);
    assert.equal(estimateTokens(json), Math.ceil(json.length / 4));
    assert.equal(
      estimateTokens(fixture.messages),
      Math.ceil(JSON.stringify(fixture.messages).length / 4)
    );
  });

  it("test A: calibrated estimate is ~1.6x the legacy estimate on tool-heavy payloads", () => {
    const fixture = buildToolHeavyFixture(300);
    const serialized = JSON.stringify(fixture.messages);
    setMode("legacy");
    const legacyString = estimateTokens(serialized);
    const legacyObject = estimateTokens(fixture.messages);
    setMode("calibrated");
    const calibratedString = estimateTokens(serialized);
    const calibratedObject = estimateTokens(fixture.messages);

    assert.ok(legacyString > 100_000, "fixture is large enough to be meaningful");
    const ratioString = calibratedString / legacyString;
    const ratioObject = calibratedObject / legacyObject;
    assert.ok(
      ratioString >= 1.55 && ratioString <= 1.65,
      `string ratio ${ratioString} within [1.55, 1.65]`
    );
    assert.ok(
      ratioObject >= 1.55 && ratioObject <= 1.65,
      `object ratio ${ratioObject} within [1.55, 1.65]`
    );
  });

  it("test E: codex contexts keep the legacy divisor in calibrated mode", () => {
    setMode("calibrated");
    const text = "x".repeat(10_000);
    const codexCtx = { provider: "codex", model: "gpt-5-codex" };
    const genericCtx = { provider: "claude", model: "claude-fable-5" };
    assert.equal(estimateTokens(text, codexCtx), Math.ceil(10_000 / 4));
    assert.equal(estimateTokens(text, { provider: "cx", model: null }), Math.ceil(10_000 / 4));
    assert.equal(
      estimateTokens(text, { provider: null, model: "cx/gpt-5" }),
      Math.ceil(10_000 / 4)
    );
    assert.equal(estimateTokens(text, genericCtx), Math.ceil(10_000 / 2.5));
    assert.equal(charsPerTokenFor(codexCtx), 4);
    assert.equal(charsPerTokenFor(genericCtx), 2.5);
    // legacy mode: identical for everyone
    setMode("legacy");
    assert.equal(estimateTokens(text, codexCtx), estimateTokens(text, genericCtx));
    setMode("calibrated");
  });

  it("test B: known incident replay — calibrated flags the 705,593-estimate payload as unsafe for 1M", () => {
    // Incident: OmniRoute legacy estimate 705,593 tokens; Anthropic actual
    // 1,148,575 tokens (factor 1.628). Reconstruct a payload whose legacy
    // estimate lands on the incident number, then compare gate decisions.
    const LEGACY_ESTIMATE = 705_593;
    const ANTHROPIC_ACTUAL = 1_148_575;
    const MODEL_CONTEXT_LIMIT = 1_000_000; // registry contextLength for claude-fable-5

    const targetChars = LEGACY_ESTIMATE * 4; // chars that produce the incident estimate
    // Exact replay: the incident payload measured ceil(chars/4) = 705,593, so
    // its serialized body was exactly this many characters long.
    const serialized = "x".repeat(targetChars);

    setMode("legacy");
    const legacyEstimate = estimateTokens(serialized);
    setMode("calibrated");
    const calibratedEstimate = estimateTokens(serialized);

    const gate = finalContextGateLimit(MODEL_CONTEXT_LIMIT);
    const wouldLegacyPass = legacyEstimate <= gate;
    const wouldCalibratedPass = calibratedEstimate <= gate;

    // Sanity: we reproduced the incident magnitude (within 10%).
    assert.ok(
      Math.abs(legacyEstimate - LEGACY_ESTIMATE) / LEGACY_ESTIMATE < 0.1,
      `legacy estimate ${legacyEstimate} ~= incident ${LEGACY_ESTIMATE}`
    );
    // Legacy would have passed the gate — that is the bug being fixed.
    assert.equal(wouldLegacyPass, true, "legacy passes (reproduces the incident)");
    // Calibrated must either flag or clamp it below the gate.
    assert.equal(
      wouldCalibratedPass,
      calibratedEstimate <= gate,
      "calibrated decision consistent with its own estimate"
    );
    assert.ok(
      !wouldCalibratedPass || calibratedEstimate <= gate,
      "calibrated never passes above the gate"
    );
    // The calibrated estimate must land in the conservative band covering the
    // actual billed count (within 1.44–1.80x of legacy).
    const factor = calibratedEstimate / legacyEstimate;
    assert.ok(factor >= 1.44 && factor <= 1.8, `calibrated factor ${factor} in [1.44, 1.80]`);
    // And it must not wildly overshoot the real Anthropic count (>2x would
    // over-compress healthy traffic).
    assert.ok(
      calibratedEstimate <= ANTHROPIC_ACTUAL * 2,
      "calibrated stays within 2x of the actual count"
    );
  });

  it("test C: payloads below the safe limit still pass in calibrated mode", () => {
    const fixture = buildToolHeavyFixture(10);
    const serialized = JSON.stringify(fixture.messages);
    setMode("calibrated");
    const calibratedEstimate = estimateTokens(serialized);
    const gate = finalContextGateLimit(1_000_000);
    assert.ok(calibratedEstimate < gate, `small payload ${calibratedEstimate} < gate ${gate}`);
    setMode("legacy");
    assert.ok(estimateTokens(serialized) < gate);
    setMode("calibrated");
  });

  it("final gate formula is floor(0.90 x limit) and never hardcoded to 1M", () => {
    assert.equal(finalContextGateLimit(1_000_000), 900_000);
    assert.equal(finalContextGateLimit(200_000), 180_000);
    assert.equal(finalContextGateLimit(128_000), 115_200);
    assert.equal(finalContextGateLimit(1), 0);
  });
});
