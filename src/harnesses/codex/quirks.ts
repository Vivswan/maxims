import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { z } from "zod";
import { flattenIssues } from "../../util/zod-issues.ts";
import {
  type AchievedTier,
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
} from "../contract.ts";
import { spec } from "./spec.ts";

// Codex enables hooks unless `[features] hooks = false` is present, so an absent key is not the
// same as `true`: a project config that leaves it unset defers to the user config, which may
// disable it. A layer that exists but cannot be read, or does not say whether hooks are on, must
// not pass for one that leaves them enabled; it is the user's own file, so the probe reads it as
// hooks off and says why rather than refusing the run over a file maxims never writes.
type Layer =
  | { kind: "absent" }
  | { kind: "flag"; flag: "enabled" | "disabled" | "unset" }
  | { kind: "unreadable"; reason: string };

const ConfigWithFeatures = z.looseObject({
  features: z.looseObject({ hooks: z.boolean().optional() }).optional(),
});

// Only a missing file, or a regular file where the config directory would be, means "this layer
// sets nothing".
const absentCodes: ReadonlySet<unknown> = new Set(["ENOENT", "ENOTDIR"]);

async function readLayer(path: string): Promise<Layer> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && absentCodes.has(cause.code)) {
      return { kind: "absent" };
    }
    return { kind: "unreadable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const parsed = parseToml(text);
  if (parsed.kind === "unreadable") return parsed;
  const config = ConfigWithFeatures.safeParse(parsed.value);
  if (!config.success) {
    return { kind: "unreadable", reason: flattenIssues(config.error.issues).join("; ") };
  }
  const hooks = config.data.features?.hooks;
  if (hooks === undefined) return { kind: "flag", flag: "unset" };
  return { kind: "flag", flag: hooks ? "enabled" : "disabled" };
}

// smol-toml's message carries a source excerpt with a caret on the lines after the first; the
// reason keeps the first line and names the position instead.
function parseToml(
  text: string,
): { kind: "value"; value: unknown } | { kind: "unreadable"; reason: string } {
  try {
    return { kind: "value", value: parse(text) };
  } catch (cause) {
    if (!(cause instanceof TomlError)) throw cause;
    const [reason = cause.message] = cause.message.split("\n");
    return {
      kind: "unreadable",
      reason: `${reason} (line ${cause.line}, column ${cause.column})`,
    };
  }
}

// config.toml layers project over user, so the project file decides the hooks flag when it sets
// one at all and the user file decides otherwise; a per-scope read of one file would call a project
// install tier 1 while the user config has hooks off.
export function layeredHooksProbe(
  roots: Pick<HarnessDefinition, "globalRoot">,
): (ctx: HarnessContext) => Promise<AchievedTier> {
  const configToml = (scope: Scope, ctx: HarnessContext): string =>
    join(scopeRoot(roots, scope, ctx), spec.hook.tierCheck.path[scope]);
  return async (ctx) => {
    const layers = [
      ...(ctx.projectRoot === null ? [] : [configToml("project", ctx)]),
      configToml("global", ctx),
    ];
    for (const path of layers) {
      const layer = await readLayer(path);
      if (layer.kind === "absent" || (layer.kind === "flag" && layer.flag === "unset")) continue;
      if (layer.kind === "unreadable") {
        return {
          tier: 2,
          unreadable: `config.toml could not be read (${path}: ${layer.reason}); assuming hooks off`,
        };
      }
      return { tier: layer.flag === "enabled" ? 1 : 2, unreadable: null };
    }
    return { tier: 1, unreadable: null };
  };
}
