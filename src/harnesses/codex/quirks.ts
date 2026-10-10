import { join } from "node:path";
import { z } from "zod";
import { flattenIssues } from "../../util/zod-issues.ts";
import {
  type AchievedTier,
  type HarnessContext,
  type HarnessDefinition,
  type Scope,
  scopeRoot,
} from "../contract.ts";
import { type ConfigReading, readConfigValue, unreadableNotice } from "../hook-writer.ts";

// Codex enables hooks unless `[features] hooks = false` is present, so an absent key is not the
// same as `true`: a project config that leaves it unset defers to the user config, which may
// disable it. A layer that exists but does not say whether hooks are on must not pass for one that
// leaves them enabled, so a non-boolean flag is as unreadable as a file that does not parse.
type Layer =
  | Exclude<ConfigReading, { kind: "value" }>
  | { kind: "flag"; flag: "enabled" | "disabled" | "unset" };

const ConfigWithFeatures = z.looseObject({
  features: z.looseObject({ hooks: z.boolean().optional() }).optional(),
});

async function readLayer(path: string): Promise<Layer> {
  const reading = await readConfigValue(path, "toml");
  if (reading.kind !== "value") return reading;
  const config = ConfigWithFeatures.safeParse(reading.value);
  if (!config.success) {
    return { kind: "unreadable", reason: flattenIssues(config.error.issues).join("; ") };
  }
  const hooks = config.data.features?.hooks;
  if (hooks === undefined) return { kind: "flag", flag: "unset" };
  return { kind: "flag", flag: hooks ? "enabled" : "disabled" };
}

// config.toml layers project over user, so the project file decides the hooks flag when it sets
// one at all and the user file decides otherwise; a per-scope read of one file would call a project
// install tier 1 while the user config has hooks off.
export function layeredHooksProbe(
  roots: Pick<HarnessDefinition, "globalRoot">,
  configPath: Record<Scope, string>,
): (ctx: HarnessContext) => Promise<AchievedTier> {
  const configToml = (scope: Scope, ctx: HarnessContext): string =>
    join(scopeRoot(roots, scope, ctx), configPath[scope]);
  return async (ctx) => {
    const layers = [
      ...(ctx.projectRoot === null ? [] : [configToml("project", ctx)]),
      configToml("global", ctx),
    ];
    for (const path of layers) {
      const layer = await readLayer(path);
      if (layer.kind === "absent" || (layer.kind === "flag" && layer.flag === "unset")) continue;
      if (layer.kind === "unreadable") {
        return { tier: 2, unreadable: unreadableNotice(path, layer.reason) };
      }
      return { tier: layer.flag === "enabled" ? 1 : 2, unreadable: null };
    }
    return { tier: 1, unreadable: null };
  };
}
