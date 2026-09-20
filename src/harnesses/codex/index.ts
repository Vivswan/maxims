import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type HarnessContext, type HarnessDefinition, type Scope, scopeRoot } from "../contract.ts";
import { configDirExists } from "../detect.ts";
import { readHooksFeatureFlag } from "./features-flag.ts";

// Codex resolves its home from $CODEX_HOME before falling back to ~/.codex; every user-level file
// (AGENTS.md, hooks.json, config.toml) moves with it.
function codexHome(ctx: HarnessContext): string {
  const override = ctx.env.CODEX_HOME;
  return override !== undefined && override !== "" ? resolve(override) : join(ctx.home, ".codex");
}

const roots = { globalRoot: codexHome };

function configDir(scope: Scope, ctx: HarnessContext): string {
  const root = scopeRoot(roots, scope, ctx);
  return scope === "global" ? root : join(root, ".codex");
}

function configToml(scope: Scope, ctx: HarnessContext): string {
  return join(configDir(scope, ctx), "config.toml");
}

// Only a missing file, or a regular file where the config directory would be, means "this layer
// sets nothing"; a config that exists but cannot be read must not pass for one that leaves hooks
// enabled.
const absentCodes: ReadonlySet<unknown> = new Set(["ENOENT", "ENOTDIR"]);

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && absentCodes.has(cause.code)) return null;
    throw cause;
  }
}

// config.toml layers project over user, so the project file decides the hooks flag when it sets
// one at all and the user file decides otherwise; a per-scope read of one file would call a project
// install tier 1 while the user config has hooks off.
async function achievedTier(ctx: HarnessContext): Promise<1 | 2> {
  const layers = [
    ...(ctx.projectRoot === null ? [] : [configToml("project", ctx)]),
    configToml("global", ctx),
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
    global: { kind: "shared-block", file: "AGENTS.md" },
  },
  bodiesDir: (scope, ctx) =>
    scope === "project" ? join(scopeRoot(roots, scope, ctx), ".agents", "memories") : null,
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
      path: configToml,
      format: "toml",
      key: "features.hooks",
      demotesWhen: false,
    },
  },
  markers: "counted",
  expands: [],
  detect: (ctx) => configDirExists(codexHome(ctx)),
  achievedTier,
  globalRoot: codexHome,
  verifiedAgainst: { url: "https://learn.chatgpt.com/docs/hooks", date: "2026-09-20" },
  fixtures: { config: "hooks.json", hookStdin: "hook-stdin.json" },
} satisfies HarnessDefinition;
