import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { type ContentHash, contentHashOf, parseMemory } from "../../memory/contract.ts";
import type { Change } from "../../util/change.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import type { SymlinkSupport } from "../types.ts";
import { realDirOf } from "./destination.ts";
import { isAbsent } from "./rules.ts";

export type BodyFile = {
  localName: string;
  storeFile: string;
  text: string;
};

export type BodiesInput = {
  dir: string;
  root: string;
  // The store root: a link's target is resolved through the store's own directories only, never
  // through a live source's entry (a symlink to the source directory), so every body link stays a
  // link into the store and the sweep still recognises it.
  store: string;
  files: readonly BodyFile[];
  copy: boolean;
  symlink: SymlinkSupport;
  // Whether a copy maxims wrote may be replaced by the link (a delete then a symlink); a hook
  // run may not delete, so it leaves the copy for the next interactive run.
  replaceCopies: boolean;
  // Content hashes of every memory text maxims has written or recorded; a regular file whose
  // hash is one of them is a copy of ours, whatever upstream has since become.
  knownCopies: ReadonlySet<ContentHash>;
};

export type BodiesPlan = {
  changes: Change[];
  notices: string[];
};

// Bodies link into the store by a RELATIVE target, so a home moved as a whole keeps resolving;
// the target is computed between the REAL directories at both ends, since the kernel resolves a
// relative link from where the link really sits, not from the spelling that reached it. `copy`
// and a machine without symlinks write the file instead. A link already resolving to the
// canonical path, or a copy already holding the text, is no change, so the plan stays empty on a
// second run. A regular file at a link's path that holds the store's bytes is a copy an earlier
// run wrote (symlinks were unavailable, or `--copy` was dropped) and becomes the link; any other
// file there is the user's and is left alone with a notice.
export function planBodies(input: BodiesInput): BodiesPlan {
  const changes: Change[] = [];
  const notices: string[] = [];
  const link = !input.copy && input.symlink.ok;
  if (!input.copy && !input.symlink.ok) {
    notices.push(
      `symlinks are not available (${input.symlink.reason}); memory bodies under ${input.dir} are copied instead (on Windows, enable Developer Mode or run as administrator to link)`,
    );
  }
  for (const file of input.files) {
    const path = assertInsideRoot(input.root, join(input.dir, `${file.localName}.md`));
    const existing = lstatSync(path, { throwIfNoEntry: false });
    // A regular file at the path that is not a copy of ours is the user's, in either mode.
    if (existing !== undefined && !existing.isSymbolicLink()) {
      if (!existing.isFile() || !isOurCopy(path, input.knownCopies)) {
        notices.push(`${path} exists and is not a link; left alone`);
        continue;
      }
    }
    if (link) {
      if (existing?.isFile()) {
        if (!input.replaceCopies) continue;
        changes.push({ kind: "delete", path });
      }
      const target = relative(realDirOf(dirname(path)), inStore(input.store, file.storeFile));
      if (existing?.isSymbolicLink() && readlinkSync(path) === target) continue;
      changes.push({ kind: "symlink", path, target });
    } else {
      if (existing?.isSymbolicLink()) changes.push({ kind: "unlink", path });
      else if (existing?.isFile() && readFileSync(path, "utf8") === file.text) continue;
      changes.push({ kind: "write", path, content: file.text });
    }
  }
  return { changes, notices };
}

// Links in a bodies directory that resolve into the store and name no wanted memory are ours
// from an earlier intent. A regular file is ours when its bytes are a memory text maxims knows,
// or when it is a memory file by the contract: a bodies directory holds copies maxims wrote, and
// a copy written before upstream moved on is recognised by no hash any longer. A user's own note
// there, one that is not a memory file, is never deleted.
export function planBodySweep(input: {
  dir: string;
  root: string;
  store: string;
  wanted: ReadonlySet<string>;
  knownCopies: ReadonlySet<ContentHash>;
  warn: (line: string) => void;
}): Change[] {
  let entries: string[];
  try {
    entries = readdirSync(input.dir);
  } catch (error) {
    if (!isAbsent(error)) input.warn(`cannot list ${input.dir}: ${describe(error)}`);
    return [];
  }
  const changes: Change[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const localName = name.slice(0, -".md".length);
    if (input.wanted.has(localName)) continue;
    const path = assertInsideRoot(input.root, join(input.dir, name));
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry === undefined) continue;
    if (entry.isSymbolicLink()) {
      const target = resolve(realDirOf(dirname(path)), readlinkSync(path));
      const store = realDirOf(input.store);
      if (target === store || target.startsWith(`${store}${sep}`)) {
        changes.push({ kind: "unlink", path });
      }
      continue;
    }
    if (entry.isFile() && isOurCopy(path, input.knownCopies))
      changes.push({ kind: "delete", path });
  }
  return changes;
}

// A store file's location with the store root resolved and the path below it kept as spelled.
function inStore(store: string, storeFile: string): string {
  return join(realDirOf(store), relative(store, storeFile));
}

// A copy maxims wrote: its bytes are a memory text maxims knows, or it is a memory file by the
// contract (a copy of an upstream version no record holds any more). The contract ties the
// frontmatter `name` to the file stem; a copy installed under a renamed local name keeps its
// upstream `name`, so the check reads that name from the frontmatter instead of the stem.
function isOurCopy(path: string, known: ReadonlySet<ContentHash>): boolean {
  const text = readFileSync(path, "utf8");
  if (known.has(contentHashOf(text))) return true;
  const declared = declaredName(text);
  return declared !== null && parseMemory(`${declared}.md`, text).ok;
}

// The `name` a memory file's frontmatter declares, read the way the contract reads it (YAML, so
// a quoted or commented value counts), or null when there is no frontmatter mapping to read.
function declaredName(text: string): string | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === null) return null;
  try {
    const frontmatter: unknown = parseYaml(match[1] ?? "");
    if (typeof frontmatter !== "object" || frontmatter === null || !("name" in frontmatter)) {
      return null;
    }
    return typeof frontmatter.name === "string" ? frontmatter.name : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
