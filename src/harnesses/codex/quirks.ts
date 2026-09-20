import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { type HarnessContext, type HarnessDefinition, type Scope, scopeRoot } from "../contract.ts";
import { spec } from "./spec.ts";

// Codex enables hooks unless `[features] hooks = false` is present, so an absent key is not the
// same as `true`: a project config that leaves it unset defers to the user config, which may
// disable it. The three states keep that layering decidable.
type HooksFeatureFlag = "enabled" | "disabled" | "unset";

const ConfigWithFeatures = z.looseObject({
  features: z.looseObject({ hooks: z.boolean().optional() }).optional(),
});

export function readHooksFeatureFlag(tomlText: string): HooksFeatureFlag {
  const hooks = ConfigWithFeatures.parse(parse(tomlText)).features?.hooks;
  if (hooks === undefined) return "unset";
  return hooks ? "enabled" : "disabled";
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
export function layeredHooksProbe(
  roots: Pick<HarnessDefinition, "globalRoot">,
): (ctx: HarnessContext) => Promise<1 | 2> {
  const configToml = (scope: Scope, ctx: HarnessContext): string =>
    join(scopeRoot(roots, scope, ctx), spec.hook.tierCheck.path[scope]);
  return async (ctx) => {
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
  };
}
