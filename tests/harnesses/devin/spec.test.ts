// Guards what Devin Local's registry demands and does not check for us: `timeout` in seconds with
// no async field. A seconds value read as milliseconds would leave the rules never refreshing
// with nothing to show for it.
import { expect, test } from "bun:test";
import { hookSpecFor } from "../../../src/harnesses/contract.ts";
import { devin } from "../../../src/harnesses/devin/spec.ts";

test("the SessionStart handler is what Devin reads", () => {
  if (devin.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(devin.hook.handler(hookSpecFor(devin)))).toBe(
    '{"type":"command","command":"npx -y @vivswan/maxims sync --quiet","timeout":20}',
  );
});
