import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import type { AchievedTier, HarnessContext, HarnessDefinition } from "../contract.ts";
import { scopeRoot } from "../contract.ts";
import { spec } from "./spec.ts";

// Claude Code reads `disableAllHooks` after settings precedence applies, and the value it finds
// governs every hook from every settings file, so the probe walks the layers it can read and lets
// the first that sets the key decide; the one file `tierCheck` names per scope would call a
// project install tier 1 while a user-level `true` has every hook off.
//
//   .claude/settings.local.json -> .claude/settings.json -> ~/.claude/settings.json
//   managed settings and --settings outrank all three and are not read
const LAYERS = [".claude/settings.local.json", ".claude/settings.json"] as const;

async function disableAllHooksIn(path: string): Promise<boolean | undefined> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return undefined;
  const errors: ParseError[] = [];
  const settings: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof settings !== "object" || settings === null) return undefined;
  const value: unknown = Reflect.get(settings, spec.hook.tierCheck.key);
  return typeof value === "boolean" ? value : undefined;
}

export function layeredDisableAllHooksProbe(
  roots: Pick<HarnessDefinition, "globalRoot">,
): (ctx: HarnessContext) => Promise<AchievedTier> {
  return async (ctx) => {
    const files = [
      ...(ctx.projectRoot === null
        ? []
        : LAYERS.map((layer) => join(scopeRoot(roots, "project", ctx), layer))),
      join(scopeRoot(roots, "global", ctx), spec.hook.tierCheck.path.global),
    ];
    for (const path of files) {
      const disabled = await disableAllHooksIn(path);
      if (disabled !== undefined) return { tier: disabled ? 2 : 1, unreadable: null };
    }
    return { tier: 1, unreadable: null };
  };
}
