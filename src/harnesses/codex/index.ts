import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExitCode, MaximsError } from "../../util/exit-codes.ts";
import type { HarnessContext, HarnessDefinition, Scope } from "../contract.ts";
import { readHooksFeatureFlag } from "./features-flag.ts";

// Codex resolves its home from $CODEX_HOME before falling back to ~/.codex, and config.toml layers
// project over user, so the project file decides the hooks flag when it sets one at all.
function codexHome(ctx: HarnessContext): string {
  const override = ctx.env.CODEX_HOME;
  return override !== undefined && override !== "" ? resolve(override) : join(ctx.home, ".codex");
}

function projectRoot(ctx: HarnessContext): string {
  if (ctx.projectRoot === null) {
    throw new MaximsError(ExitCode.Usage, "a project-scope Codex path needs a project root");
  }
  return ctx.projectRoot;
}

function configDir(scope: Scope, ctx: HarnessContext): string {
  return scope === "global" ? codexHome(ctx) : join(projectRoot(ctx), ".codex");
}

// Only a missing file means "this layer sets nothing"; a config that exists but cannot be read
// must not pass for one that leaves hooks enabled.
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
}

async function achievedTier(ctx: HarnessContext): Promise<1 | 2> {
  const layers = [
    ...(ctx.projectRoot === null ? [] : [join(ctx.projectRoot, ".codex", "config.toml")]),
    join(codexHome(ctx), "config.toml"),
  ];
  for (const path of layers) {
    const text = await readIfPresent(path);
    if (text === null) continue;
    const flag = readHooksFeatureFlag(text);
    if (flag !== "unset") return flag === "enabled" ? 1 : 2;
  }
  return 1;
}

export const codex = {
  id: "codex",
  displayName: "Codex",
  tier: 1,
  targets: {
    project: { kind: "shared-block", file: "AGENTS.md" },
    global: { kind: "shared-block", file: ".codex/AGENTS.md" },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(projectRoot(ctx), ".agents", "memories") : null,
  hook: {
    kind: "registry",
    path: (scope, ctx) => join(configDir(scope, ctx), "hooks.json"),
    format: "json",
    eventPath: ["hooks", "SessionStart"],
    grouped: true,
    handler: (spec) => ({
      type: "command",
      command: [spec.command, ...spec.args].join(" "),
      timeout: spec.timeoutSeconds,
      async: spec.async,
      statusMessage: "Syncing maxims",
    }),
    commandKey: "command",
    stdout: "plain",
    async: true,
    tierCheck: {
      path: ".codex/config.toml",
      format: "toml",
      key: "features.hooks",
      expectedValue: true,
    },
  },
  markers: "counted",
  expands: [],
  detect: (ctx) => ctx.env.CODEX_HOME !== undefined || existsSync(join(ctx.home, ".codex")),
  achievedTier,
  verifiedAgainst: { url: "https://learn.chatgpt.com/docs/hooks", date: "2026-09-20" },
  fixtures: { config: "hooks.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessDefinition;
