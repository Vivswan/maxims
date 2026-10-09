import { toDefinition } from "../from-spec.ts";
import { layeredDisableAllHooksProbe } from "./quirks.ts";
import { spec } from "./spec.ts";

export const claudeCode = toDefinition(spec, (declared) => ({
  achievedTier: layeredDisableAllHooksProbe(declared),
}));
