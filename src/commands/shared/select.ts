import type { MemoryName } from "../../memory/contract.ts";
import type { Candidate } from "../../rulefile/dedupe.ts";
import { shortHash } from "../../rulefile/dedupe.ts";
import type { RenameMap, Select, SourceIntent, State } from "../../state/schema.ts";
import { contentHash, type SourceMemory } from "./memories.ts";

export type SelectedMemory = {
  memory: SourceMemory;
  upstreamName: MemoryName;
  localName: MemoryName;
  candidate: Candidate;
};

export type Selection = {
  selected: SelectedMemory[];
  hiddenInternal: number;
  disabledDropped: MemoryName[];
  // Upstream names of every memory the selection admits before the disabled list, for the name
  // index: a disabled memory still owns its name at the other scope.
  ownedUpstreamNames: MemoryName[];
};

export type SelectInput = {
  memories: readonly SourceMemory[];
  intent: Pick<SourceIntent, "select" | "rename">;
  installInternal: boolean;
  disabled: ReadonlySet<string>;
  detailPath: (memory: SourceMemory, localName: MemoryName) => string;
};

// The effective memory set of one source at one scope: `select`, the internal opt-in, the
// rename map, then the scope's disabled names by their LOCAL name. An explicit name in `select`
// always wins over the internal skip.
export function selectMemories(input: SelectInput): Selection {
  const selected: SelectedMemory[] = [];
  const disabledDropped: MemoryName[] = [];
  const ownedUpstreamNames: MemoryName[] = [];
  let hiddenInternal = 0;
  for (const memory of input.memories) {
    const upstreamName = memory.memory.name;
    if (!inSelect(input.intent.select, upstreamName)) continue;
    const explicit = input.intent.select !== "*";
    if (memory.memory.metadata.internal === true && !explicit && !input.installInternal) {
      hiddenInternal += 1;
      continue;
    }
    ownedUpstreamNames.push(upstreamName);
    const localName = renamed(input.intent.rename, upstreamName);
    if (input.disabled.has(localName)) {
      disabledDropped.push(localName);
      continue;
    }
    selected.push({
      memory,
      upstreamName,
      localName,
      candidate: {
        name: upstreamName,
        description: memory.memory.description,
        contentHash: contentHash(memory.text),
        detailPath: input.detailPath(memory, localName),
      },
    });
  }
  return { selected, hiddenInternal, disabledDropped, ownedUpstreamNames };
}

export function inSelect(select: Select, name: MemoryName): boolean {
  return select === "*" || select.includes(name);
}

export function renamed(rename: RenameMap, name: MemoryName): MemoryName {
  return Object.hasOwn(rename, name) ? rename[name] : name;
}

export function shortHashOf(memory: SourceMemory): string {
  return shortHash(contentHash(memory.text));
}

// The names switched off at one scope. State may carry a `disabled` record once the schema
// lands it; until then every scope's list is empty, and this is the one reader either way.
export type DisabledCarrier = Pick<State, "sources"> & {
  disabled?: { global?: readonly MemoryName[]; project?: Record<string, readonly MemoryName[]> };
};

export function disabledNames(
  state: DisabledCarrier,
  scope: "project" | "global" | "out",
  projectRoot: string | null,
): ReadonlySet<string> {
  if (scope === "global") return new Set(state.disabled?.global ?? []);
  if (scope === "project" && projectRoot !== null) {
    return new Set(state.disabled?.project?.[projectRoot] ?? []);
  }
  return new Set();
}
