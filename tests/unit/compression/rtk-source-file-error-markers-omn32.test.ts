/**
 * Regression for OMN-32: a coding agent reading a large Python file through RTK got back
 * ~4% of the file (blank lines and the whole middle dropped), then produced broken edits.
 *
 * Root cause: the #4559 document-read guard bailed out on ANY `Error:` / `Exception:`
 * substring, and source files carry those as code (`except ValueError:`,
 * `logger.error(f"Error: {e}")`). One such line reclassified the file as generic error
 * output and sent it through the truncating generic-output filter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processRtkText } from "../../../open-sse/services/compression/engines/rtk/index.ts";

const CONFIG = { maxLinesPerResult: 120, maxCharsPerResult: 12000 };

function buildPythonModule(handlerLine: string): string {
  const lines = ["import logging", "", "logger = logging.getLogger(__name__)", ""];
  for (let i = 0; i < 300; i++) {
    lines.push(`def handler_${i}(payload):`);
    lines.push(`    """Process field ${i}.`);
    lines.push("");
    lines.push("    Raises:");
    lines.push(`        KeyError: if field_${i} is missing.`);
    lines.push('    """');
    lines.push("    try:");
    lines.push(`        return process_${i}(payload["field_${i}"])`);
    lines.push(handlerLine);
    lines.push(`        logger.error(f"Error: handler ${i} failed: {exc}")`);
    lines.push("        return None");
    lines.push("");
  }
  return lines.join("\n");
}

describe("RTK source-file read with error-like code — OMN-32", () => {
  for (const handlerLine of ["    except ValueError as exc:", "    except Exception as exc:"]) {
    it(`keeps a 3.6k-line Python file intact (${handlerLine.trim()})`, () => {
      const source = buildPythonModule(handlerLine);
      const result = processRtkText(source, { config: CONFIG });

      assert.ok(
        !result.techniquesUsed.includes("rtk-filter") &&
          !result.techniquesUsed.includes("rtk-truncate"),
        `source read must not be filtered or truncated; got ${result.techniquesUsed.join(", ")}`
      );
      assert.equal(result.text, source, "the file must reach the model byte-for-byte");
    });
  }

  it("still filters real error output", () => {
    const lines = ["Error: request failed"];
    for (let i = 0; i < 200; i++) lines.push(`    at handler${i} (/srv/app/handler${i}.js:${i}:7)`);
    const result = processRtkText(lines.join("\n"), { config: CONFIG });

    assert.ok(
      result.techniquesUsed.includes("rtk-filter") ||
        result.techniquesUsed.includes("rtk-truncate"),
      `a 200-frame stack trace should still be compressed; got ${result.techniquesUsed.join(", ")}`
    );
    assert.ok(result.text.length < lines.join("\n").length);
  });

  it("still treats a Python traceback as error output", () => {
    const lines = ["Traceback (most recent call last):"];
    for (let i = 0; i < 200; i++) lines.push(`  File "app.py", line ${i}, in step_${i}`);
    lines.push("RuntimeError: boom");
    const result = processRtkText(lines.join("\n"), { config: CONFIG });

    assert.ok(result.text.length < lines.join("\n").length, "traceback should be compressed");
    assert.ok(result.text.includes("RuntimeError: boom"), "the error line survives");
  });
});
