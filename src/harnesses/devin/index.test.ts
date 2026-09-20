// Guards what Devin Local's registry demands and does not check for us: `timeout` in seconds with
// no async field, the entry in config.json in both scopes (the standalone hooks file has no
// user-level twin), and every global file under `~/.config/devin`. A seconds value read as
// milliseconds, or a hook written where only the project layer looks, would leave the rules never
// refreshing with nothing to show for it.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { hookSpecFor, scopeRoot } from "../contract.ts";
import { devin } from "./index.ts";

const ctx = { home: "/home/user", projectRoot: "/home/user/project", env: {} };

test("the SessionStart handler and its registry paths are what Devin reads", () => {
  if (devin.hook.kind !== "registry") throw new Error("expected a registry hook");
  expect(JSON.stringify(devin.hook.handler(hookSpecFor(devin)))).toBe(
    '{"type":"command","command":"npx -y @vivswan/maxims sync --quiet","timeout":20}',
  );
  expect(devin.hook.path("project", ctx)).toBe("/home/user/project/.devin/config.json");
  expect(devin.hook.path("global", ctx)).toBe("/home/user/.config/devin/config.json");
});

test("the global rule block and MCP config live under ~/.config/devin", () => {
  const target = devin.targets.global;
  if (target?.kind !== "shared-block") throw new Error("expected a shared block");
  expect(join(scopeRoot(devin, "global", ctx), target.file)).toBe(
    "/home/user/.config/devin/AGENTS.md",
  );
  expect(devin.mcp?.path("global", ctx)).toBe("/home/user/.config/devin/mcp_config.json");
  expect(devin.mcp?.path("project", ctx)).toBe("/home/user/project/.devin/mcp_config.json");
});
