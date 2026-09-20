import { toDefinition } from "../from-spec.ts";
import { bridgeReconciler } from "./quirks.ts";
import { spec } from "./spec.ts";

export const dsh = toDefinition(spec, (declared) => ({ reconcile: bridgeReconciler(declared) }));
