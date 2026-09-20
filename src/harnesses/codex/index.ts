import { toDefinition } from "../from-spec.ts";
import { layeredHooksProbe } from "./quirks.ts";
import { spec } from "./spec.ts";

export const codex = toDefinition(spec, (declared) => ({
  achievedTier: layeredHooksProbe(declared),
}));
