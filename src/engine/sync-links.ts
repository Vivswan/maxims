// The link judgment of a sync, and the kept files it counts as owned whole. `planInstall` builds
// it once every file this run visits is registered, before the render, and hands it to the hook
// planner.

import { followLinks, realKeyOf } from "../util/fs.ts";
import type { HarnessTarget } from "./destination.ts";
import type { LinkJudge } from "./hooks.ts";
import { LinkedAtRuleFile, ownedWhole, type RuleFile } from "./rules.ts";
import { fileIdentity } from "./sync-rule-files.ts";

// A rule file kept as it is this run: a harness's, which the file's render counts as a reader, or
// a `-o` source's, which has no reader and is kept by its real path alone.
export type Retained =
  | { key: string; kind: "harness"; target: HarnessTarget }
  | { key: string; kind: "out"; realKey: string };

export function unhandledRetained(kept: never): Error {
  return new Error(`unhandled retained kind ${String(kept)}`);
}

// The one judgment of a link this run edits a user-owned file through, a shared file's or a
// registry's: a hop that is a rule file maxims owns whole is refused by name, since written whole
// that file would take the edit and cut off the reader whose link passes it.
export function linkJudge(
  files: ReadonlyMap<string, RuleFile>,
  retained: readonly Retained[],
): LinkJudge {
  const whole = new Set<string>();
  for (const file of files.values()) if (ownedWhole(file)) whole.add(fileIdentity(file));
  for (const kept of retained) {
    switch (kept.kind) {
      case "out":
        whole.add(kept.realKey);
        break;
      case "harness":
        if (kept.target.target.kind === "rules-dir") whole.add(kept.target.realKey);
        break;
      default:
        throw unhandledRetained(kept);
    }
  }
  return (link, keys = []) => {
    for (const hop of followLinks(link).hops) {
      if (whole.has(realKeyOf(hop))) throw new LinkedAtRuleFile(keys, link, hop);
    }
  };
}

// Every link a reader reaches a shared file by, the file's own name included, whether or not a
// source renders a block into it this run: the orphan strip edits the file through the same link.
export function refuseLinksThroughRuleFiles(
  files: ReadonlyMap<string, RuleFile>,
  judge: LinkJudge,
): void {
  for (const file of files.values()) {
    if (file.kind !== "harness" || file.owned !== "shared") continue;
    const keys = file.blocks.map((block) => block.key);
    const links = new Set([file.path, ...file.targets.map((t) => t.path), ...file.aliases]);
    for (const link of links) judge(link, keys);
  }
}
