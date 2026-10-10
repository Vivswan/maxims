import { join } from "node:path";
import type { AchievedTier, HarnessContext, HarnessDefinition } from "../contract.ts";
import { scopeRoot } from "../contract.ts";
import { readConfigValue, unreadableNotice } from "../hook-writer.ts";

// Claude Code reads `disableAllHooks` after settings precedence applies, and the value it finds
// governs every hook from every settings file, so the probe walks the layers it can read and lets
// the first that sets the key decide; the one file `tierCheck` names per scope would call a
// project install tier 1 while a user-level `true` has every hook off.
//
//   .claude/settings.local.json -> .claude/settings.json -> ~/.claude/settings.json
//   managed settings and --settings outrank all three and are not read
const LAYERS = [".claude/settings.local.json", ".claude/settings.json"] as const;

// A layer decides the tier when it sets the key, and when it cannot be read: what Claude Code makes
// of a broken settings file is not for the layer below to answer, so the walk stops there with the
// reason. An absent or silent layer defers.
async function tierDecidedBy(path: string, key: string): Promise<AchievedTier | null> {
  const reading = await readConfigValue(path, "json");
  if (reading.kind === "absent") return null;
  if (reading.kind === "unreadable") {
    return { tier: 2, unreadable: unreadableNotice(path, reading.reason) };
  }
  const settings = reading.value;
  if (typeof settings !== "object" || settings === null) return null;
  const value: unknown = Reflect.get(settings, key);
  return typeof value === "boolean" ? { tier: value ? 2 : 1, unreadable: null } : null;
}

export function layeredDisableAllHooksProbe(
  roots: Pick<HarnessDefinition, "globalRoot">,
  tierCheck: { path: { global: string }; key: string },
): (ctx: HarnessContext) => Promise<AchievedTier> {
  return async (ctx) => {
    const files = [
      ...(ctx.projectRoot === null
        ? []
        : LAYERS.map((layer) => join(scopeRoot(roots, "project", ctx), layer))),
      join(scopeRoot(roots, "global", ctx), tierCheck.path.global),
    ];
    for (const path of files) {
      const decided = await tierDecidedBy(path, tierCheck.key);
      if (decided !== null) return decided;
    }
    return { tier: 1, unreadable: null };
  };
}
