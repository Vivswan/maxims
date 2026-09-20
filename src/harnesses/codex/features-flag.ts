import { parse } from "smol-toml";
import { z } from "zod";

// Codex enables hooks unless `[features] hooks = false` is present, so an absent key is not the
// same as `true`: a project config that leaves it unset defers to the user config, which may
// disable it. The three states keep that layering decidable.
export type HooksFeatureFlag = "enabled" | "disabled" | "unset";

const ConfigWithFeatures = z.looseObject({
  features: z.looseObject({ hooks: z.boolean().optional() }).optional(),
});

export function readHooksFeatureFlag(tomlText: string): HooksFeatureFlag {
  const hooks = ConfigWithFeatures.parse(parse(tomlText)).features?.hooks;
  if (hooks === undefined) return "unset";
  return hooks ? "enabled" : "disabled";
}
