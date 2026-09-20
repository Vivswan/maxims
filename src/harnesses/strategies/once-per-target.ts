import type { HarnessDefinition } from "../contract.ts";

// One target file carries the self-refresh line at most once, in the first stale block by byte
// order of source name, so three stale sources yield one instruction and the file is byte-identical
// across runs. Tier 1 has a hook that already refreshes, so no block there earns the line.
export function chooseSelfRefreshSource(
  def: Pick<HarnessDefinition, "tier">,
  staleSources: Iterable<string>,
): string | null {
  if (def.tier === 1) return null;
  let first: string | null = null;
  for (const source of staleSources) {
    if (first === null || source < first) first = source;
  }
  return first;
}
