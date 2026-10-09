import type { LastError } from "../contracts/last-error.ts";
import type { MemoryName } from "../memory/contract.ts";

export type RuleLine = {
  name: MemoryName;
  description: string;
  detailPath: string;
  shortHash: string;
};

// "stripped": the harness drops block-level HTML comments before injection, so markers cost no
// tokens. "counted": they ride into context and the marker pair shrinks to one line.
export type Markers = "stripped" | "counted";

// Each harness definition declares, in `HarnessDefinition.expands`, which reference syntaxes its
// instruction files expand at load; the block renderer escapes every token that would trigger one.
// A harness whose syntax is undocumented declares nothing and gets conservative escaping.
export type ExpansionSyntax = "at-import" | "none";

export type Staleness = {
  since: string;
  kind: LastError["kind"] | "age";
};

// The one vocabulary a staleness kind is said in, by the rule-file line and the sync notice alike.
export const STALE_REASON: Record<Staleness["kind"], string> = {
  age: "no successful fetch",
  network: "network unreachable",
  ratelimit: "rate limited",
  missing: "source repository gone or unreadable",
  auth: "authentication failed",
  invalid: "source content invalid",
};

// The one sentence a stale source is said in, by the rule-file line and the sync notice alike;
// each puts its own plural subject in front (`the rules below from <key>`, `the rules from <key>`).
// `since` stays the full timestamp: the rule-file line is recognized on a later run by that shape.
export function staleSentence(subject: string, stale: Staleness): string {
  return `${subject} have not refreshed since ${stale.since} (${STALE_REASON[stale.kind]}) and may be out of date.`;
}

export type BlockInput = {
  source: string;
  sha: string;
  lines: RuleLine[];
  markers: Markers;
  expands: ExpansionSyntax[];
  stale?: Staleness;
  selfRefresh: boolean;
  frontmatter?: string;
};

/** @public */
export type RenderBlock = (input: BlockInput) => string;
