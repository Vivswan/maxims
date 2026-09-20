// Guards the unit Gemini CLI reads `timeout` in: milliseconds, unlike every other registry. A
// handler that copied the shared seconds value through would give sync 20ms before Gemini killed
// it, and the only symptom would be rules that never refresh. Pinned as the bytes the writer emits.
import { expect, test } from "bun:test";
import { hookSpecFor } from "../contract.ts";
import { geminiCli } from "./index.ts";

test("the handler carries the shared timeout as milliseconds and no async field", () => {
  expect(JSON.stringify(geminiCli.hook.handler(hookSpecFor(geminiCli)))).toBe(
    '{"name":"maxims-sync","type":"command","command":"npx -y maxims sync --quiet","timeout":20000}',
  );
});
