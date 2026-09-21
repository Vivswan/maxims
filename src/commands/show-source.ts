import { createTwoFilesPatch } from "diff";
import type { HarnessId } from "../contracts/harness-id.ts";
import { DEFAULT_GIT_REF } from "../contracts/source.ts";
import type { MemoryName } from "../memory/contract.ts";
import type { Pending, RenameMap, Select, SourceEntry, State } from "../state/schema.ts";
import { storePathFor } from "../util/home.ts";
import { isFetchedEntry, readInstalledTree, shortSha } from "./shared/engine.ts";
import { type FetchedEntry, type HeldRevision, readHeldRevision } from "./shared/fetch.ts";
import { disabledNames, type SelectedMemory, selectMemories } from "./shared/select.ts";
import type { CliIo } from "./types.ts";

export type SourceRef =
  | { kind: "tracking" | "pinned"; ref: string }
  | { kind: "copied" | "live"; path: string };

// The rule lines a held revision adds, removes or changes against the installed store copy, both
// read through the source's selection and rename map so a hidden or unselected memory never
// appears, and every memory whose file text differs (an added or removed one against nothing)
// with a unified diff of each. A hold whose files are gone, altered since the hold, or unreadable
// says so rather than reporting no changes.
export type HeldChanges =
  | {
      sha: string;
      at: string;
      added: { name: MemoryName; description: string }[];
      removed: MemoryName[];
      changed: { name: MemoryName; from: string; to: string }[];
      bodies: { name: MemoryName; diff: string }[];
    }
  | { sha: string; at: string; unreadable: string };

export type SourceFacts = {
  key: string;
  sha: string | null;
  ref: SourceRef;
  fetchedAt: string | null;
  scope: "global" | "project" | "out";
  location: string | null;
  harnesses: HarnessId[];
  rule: boolean;
  select: Select;
  rename: RenameMap;
  installed: number | null;
  disabled: MemoryName[];
  review: boolean;
  held: HeldChanges | null;
};

export type SourceLookup = { facts: SourceFacts; notices: string[] };

export async function sourceFacts(
  state: State,
  io: CliIo,
  key: string,
  entry: SourceEntry,
): Promise<SourceLookup> {
  const notices: string[] = [];
  const { intent } = entry;
  const { destination } = intent;
  const installInternal = io.env.MAXIMS_INSTALL_INTERNAL === "1";
  const tree = await readInstalledTree(entry, storePathFor(io.home, intent.from), (line) =>
    notices.push(`maxims: ${key}: ${line}`),
  );
  if (tree.kind !== "tree") notices.push(`maxims: ${key}: ${tree.reason}`);
  const installed =
    tree.kind === "tree"
      ? selectMemories({
          memories: tree.tree.memories,
          intent,
          installInternal,
          disabled: new Set(),
          detailPath: () => "",
        }).selected
      : null;
  const scoped = disabledNames(
    state,
    destination.scope,
    destination.scope === "project" ? destination.root : null,
  );
  const fetched = isFetchedEntry(entry) ? entry.fetched : undefined;
  const pending = isFetchedEntry(entry) ? entry.pending : undefined;
  const facts: SourceFacts = {
    key,
    sha: fetched?.sha ?? (tree.kind === "tree" ? tree.tree.sha : null),
    ref: refOf(entry),
    fetchedAt: fetched?.at ?? null,
    scope: destination.scope,
    location:
      destination.scope === "project"
        ? destination.root
        : destination.scope === "out"
          ? destination.path
          : null,
    harnesses: [...intent.harnesses],
    rule: intent.rule,
    select: intent.select,
    rename: intent.rename,
    installed: installed === null ? null : installed.length,
    disabled: (installed ?? [])
      .map((memory) => memory.localName)
      .filter((name) => scoped.has(name)),
    review: intent.review === true,
    held:
      pending === undefined || !isFetchedEntry(entry)
        ? null
        : await heldChanges(key, entry, installed, pending, installInternal, io.home),
  };
  return { facts, notices };
}

function refOf(entry: SourceEntry): SourceRef {
  const { from } = entry.intent;
  if (from.type === "local") {
    return { kind: from.live === true ? "live" : "copied", path: from.path };
  }
  return from.ref === DEFAULT_GIT_REF
    ? { kind: "tracking", ref: from.ref }
    : { kind: "pinned", ref: from.ref };
}

async function heldChanges(
  key: string,
  entry: FetchedEntry,
  installed: SelectedMemory[] | null,
  pending: Pending,
  installInternal: boolean,
  home: string,
): Promise<HeldChanges> {
  const { sha, at } = pending;
  if (installed === null) {
    return { sha, at, unreadable: `the installed copy of ${key} could not be read` };
  }
  let revision: HeldRevision;
  try {
    revision = await readHeldRevision(key, entry, pending, home, installInternal);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { sha, at, unreadable: `the held revision of ${key} could not be read: ${detail}` };
  }
  if (revision.kind === "forgotten") return { sha, at, unreadable: revision.line };
  const held = selectMemories({
    memories: revision.memories,
    intent: entry.intent,
    installInternal,
    disabled: new Set(),
    detailPath: () => "",
  }).selected;
  // Keyed by upstream name, the identity the hold's summary and the accept compare by: a memory
  // upstream adds under a name a rename already occupies is then listed, as the sync will refuse
  // it, instead of vanishing behind the memory it collides with.
  const before = new Map(installed.map((memory) => [memory.upstreamName, memory]));
  const after = new Map(held.map((memory) => [memory.upstreamName, memory]));
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: Extract<HeldChanges, { added: unknown }> = {
    sha,
    at,
    added: [],
    removed: [],
    changed: [],
    bodies: [],
  };
  for (const upstream of names) {
    const was = before.get(upstream);
    const is = after.get(upstream);
    const name = (is ?? was)?.localName ?? upstream;
    if (was === undefined && is !== undefined) {
      changes.added.push({ name, description: is.memory.memory.description });
    } else if (was !== undefined && is === undefined) {
      changes.removed.push(name);
    } else if (was !== undefined && is !== undefined) {
      const from = was.memory.memory.description;
      const to = is.memory.memory.description;
      if (from !== to) changes.changed.push({ name, from, to });
    }
    const oldText = was?.memory.text ?? "";
    const newText = is?.memory.text ?? "";
    if (oldText !== newText) {
      changes.bodies.push({
        name,
        diff: createTwoFilesPatch(
          `installed/${name}.md`,
          `held/${name}.md`,
          oldText,
          newText,
          undefined,
          undefined,
          { context: 3 },
        ),
      });
    }
  }
  return changes;
}

export function sourceFactLines(facts: SourceFacts): string[] {
  const revision = facts.sha === null ? "-" : shortSha(facts.sha);
  const fetched =
    facts.fetchedAt === null ? "" : `, fetched ${facts.fetchedAt.slice(0, "2026-01-01".length)}`;
  const count = facts.installed === null ? "not readable" : `${facts.installed} installed`;
  const selection = `${facts.select === "*" ? "*" : facts.select.join(", ")} (${count})`;
  const renames = Object.entries(facts.rename).map(([from, to]) => `${from} -> ${to}`);
  return [
    `revision: ${revision} (${describeRef(facts.ref)})${fetched}`,
    `scope: ${facts.scope}${facts.location === null ? "" : ` ${facts.location}`}`,
    `agents: ${facts.harnesses.join(", ")}`,
    `rules: ${facts.rule ? "yes" : "no"}`,
    `selection: ${selection}`,
    `renames: ${renames.length === 0 ? "none" : renames.join(", ")}`,
    `disabled: ${facts.disabled.length === 0 ? "none" : facts.disabled.join(", ")}`,
    `review: ${reviewLine(facts)}`,
  ];
}

function describeRef(ref: SourceRef): string {
  switch (ref.kind) {
    case "tracking":
      return `tracking ${ref.ref}`;
    case "pinned":
      return `pinned to ${ref.ref}`;
    case "copied":
      return "copied directory";
    case "live":
      return "live directory";
  }
}

function reviewLine(facts: SourceFacts): string {
  if (!facts.review) return "off";
  const { held } = facts;
  if (held === null) return "on; nothing held";
  const since = held.at.slice(0, "2026-01-01".length);
  if ("unreadable" in held) return `on; a revision held since ${since} (${held.unreadable})`;
  const count = held.added.length + held.removed.length + held.changed.length;
  return `on; ${count} changed ${count === 1 ? "line" : "lines"} held since ${since}`;
}

// The held block's lines after its title, without the diffs, which the caller prints verbatim.
export function heldLines(held: Extract<HeldChanges, { added: unknown }>): string[] {
  const lines = [
    ...held.added.map((memory) => `+ ${memory.name}  ${memory.description}`),
    ...held.removed.map((name) => `- ${name}`),
    ...held.changed.map((memory) => `~ ${memory.name}  ${memory.from} -> ${memory.to}`),
  ];
  if (held.bodies.length > 0) {
    lines.push(`bodies: ${held.bodies.map((body) => body.name).join(", ")}`);
  }
  return lines;
}
