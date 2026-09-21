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
