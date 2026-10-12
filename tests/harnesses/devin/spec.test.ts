// Guards what Devin Local's registry demands and does not check for us: `timeout` in seconds with
// no async field. A seconds value read as milliseconds would leave the rules never refreshing
// with nothing to show for it. Devin's config files take comments (its own docs), so a commented
// config.json is a file Devin loads and the hook goes in beside the comment.
import { expect, test } from "bun:test";
import { HOOK_COMMAND, hookSpecFor } from "../../../src/harnesses/contract.ts";
import { devin } from "../../../src/harnesses/devin/spec.ts";
import { hasHook, planHookRegistryWrite } from "../../../src/harnesses/hook-writer.ts";
import { exampleContext as ctx } from "../context.ts";

test("the SessionStart handler is what Devin reads", () => {
  if (devin.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(devin.hook.handler(hookSpecFor(devin)))).toBe(
    '{"type":"command","command":"npx -y @vivswan/maxims sync --quiet","timeout":20}',
  );
});

test("a config.json holding a comment is edited with the comment kept", () => {
  if (!hasHook(devin, "registry")) throw new Error("expected a registry hook");
  const currentText = '{\n  // keep\n  "read_config_from": { "claude": true }\n}\n';
  const [edit] = planHookRegistryWrite({
    def: devin,
    scope: "global",
    ctx,
    wanted: true,
    currentText,
  }).changes;
  if (edit?.kind !== "edit") throw new Error("expected the registry edit");
  expect([edit.content.includes("// keep"), edit.content.includes(HOOK_COMMAND)]).toEqual([
    true,
    true,
  ]);
});
