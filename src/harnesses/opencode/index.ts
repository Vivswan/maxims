import { toDefinition } from "../from-spec.ts";
import { configEdit } from "./quirks.ts";
import { spec } from "./spec.ts";

export const opencode = toDefinition(spec, { configEdit });
