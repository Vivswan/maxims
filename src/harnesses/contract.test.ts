// Guards the hook contract the registry writers search by: the command written into a harness
// config must start with the prefix `remove` later looks for, or removal would leave orphan hooks.
import { expect, test } from "bun:test";
import { HOOK_COMMAND, HOOK_COMMAND_PREFIX, type HookShape, hookSpecFor } from "./contract.ts";

const shapes: [string, HookShape, boolean][] = [
  ["none", { kind: "none" }, false],
  [
    "registry async",
    {
      kind: "registry",
      path: () => "/home/user/.claude/settings.json",
      format: "json",
      event: "SessionStart",
      matcherless: true,
      async: true,
    },
    true,
  ],
  [
    "registry sync",
    {
      kind: "registry",
      path: () => "/home/user/.codex/hooks.json",
      format: "json",
      event: "SessionStart",
      matcherless: true,
      async: false,
    },
    false,
  ],
  ["file", { kind: "file", path: () => "/x", render: () => "", executable: true }, false],
  ["custom", { kind: "custom", reconcile: async () => [] }, false],
];

test.each(shapes)(
  "hookSpecFor(%s) spells the searchable command and carries the async flag",
  (_, hook, async) => {
    const spec = hookSpecFor({ hook });
    const commandLine = [spec.command, ...spec.args].join(" ");
    expect(commandLine).toBe(HOOK_COMMAND);
    expect(commandLine.startsWith(`${HOOK_COMMAND_PREFIX} `)).toBe(true);
    expect(spec.async).toBe(async);
    expect(spec.timeoutSeconds).toBeGreaterThan(0);
    expect(spec.command).toBe("npx");
    expect(spec.args).toContain("--quiet");
  },
);
