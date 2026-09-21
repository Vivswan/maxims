import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { type RootedPath, writeFileAtomic } from "./fs.ts";

// Every `path` is a RootedPath, so a change can only name a location some planner has already
// proven to lie under its destination root; a symlink `target` may point anywhere (the store).
export type Change =
  | { kind: "write"; path: RootedPath; content: string; mode?: number }
  | { kind: "delete"; path: RootedPath }
  | { kind: "symlink"; path: RootedPath; target: string }
  | { kind: "unlink"; path: RootedPath }
  | { kind: "mkdir"; path: RootedPath };

export type Plan = {
  changes: Change[];
  notices: string[];
};

export type ApplyOptions = {
  dryRun: boolean;
};

export type ApplyResult = {
  applied: Change[];
};

// A real file or directory where `unlink` or `symlink` expects a link is the user's work: it leaves
// only through an explicit `delete` in the plan, never by an implicit replacement. A repointed link
// is created beside the old one and renamed over it, so no reader sees it absent.
export async function applyChanges(plan: Plan, options: ApplyOptions): Promise<ApplyResult> {
  if (options.dryRun) return { applied: [] };
  const applied: Change[] = [];
  for (const change of plan.changes) {
    if (await applyOne(change)) applied.push(change);
  }
  return { applied };
}

async function applyOne(change: Change): Promise<boolean> {
  switch (change.kind) {
    case "write": {
      const existing = await lstatOrNull(change.path);
      const current = existing?.isFile()
        ? await guardedValue(change.path, () => readFile(change.path, "utf8"))
        : null;
      if (current !== change.content) {
        writeFileAtomic(change.path, change.content, { mode: change.mode });
        return true;
      }
      if (
        change.mode !== undefined &&
        existing !== null &&
        (existing.mode & 0o7777) !== change.mode
      ) {
        await guarded(change.path, () => chmod(change.path, change.mode as number));
        return true;
      }
      return false;
    }
    case "delete": {
      const entry = await lstatOrNull(change.path);
      if (entry === null) return false;
      await guarded(change.path, () =>
        entry.isSymbolicLink() ? unlink(change.path) : rm(change.path, { recursive: true }),
      );
      return true;
    }
    case "symlink": {
      const entry = await lstatOrNull(change.path);
      if (entry !== null) {
        if (!entry.isSymbolicLink()) {
          throw new MaximsError(
            ExitCode.DestinationWriteFailed,
            `refusing to replace ${change.path} with a symlink: it is not a symlink`,
          );
        }
        if ((await readlink(change.path)) === change.target) return false;
      }
      await guarded(change.path, async () => {
        const dir = dirname(change.path);
        await mkdir(dir, { recursive: true });
        const temp = join(dir, `.${randomBytes(6).toString("hex")}.lnk`);
        await symlink(change.target, temp);
        await rename(temp, change.path).catch(async (error: unknown) => {
          await unlink(temp).catch(() => undefined);
          throw error;
        });
      });
      return true;
    }
    case "unlink": {
      const entry = await lstatOrNull(change.path);
      if (entry === null) return false;
      if (!entry.isSymbolicLink()) {
        throw new MaximsError(
          ExitCode.DestinationWriteFailed,
          `refusing to unlink ${change.path}: it is not a symlink`,
        );
      }
      await guarded(change.path, () => unlink(change.path));
      return true;
    }
    case "mkdir": {
      const entry = await statOrNull(change.path);
      if (entry?.isDirectory()) return false;
      await guarded(change.path, () => mkdir(change.path, { recursive: true }));
      return true;
    }
  }
}

// Only "nothing is there" reads as absent; a probe that could not look (EACCES on a parent, an
// I/O error) surfaces as exit 4 rather than as a change that silently did not happen.
function lstatOrNull(path: string): Promise<Stats | null> {
  return probe(path, lstat);
}

// A directory reached through a link already exists for mkdir's purposes, so this probe follows.
function statOrNull(path: string): Promise<Stats | null> {
  return probe(path, stat);
}

async function probe(path: string, look: (path: string) => Promise<Stats>): Promise<Stats | null> {
  try {
    return await look(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `cannot inspect ${path}: ${detail(error)}`,
      {
        cause: error,
      },
    );
  }
}

async function guarded(path: string, action: () => Promise<unknown>): Promise<void> {
  await guardedValue(path, action);
}

async function guardedValue<T>(path: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw new MaximsError(
      ExitCode.DestinationWriteFailed,
      `cannot update ${path}: ${detail(cause)}`,
      {
        cause,
      },
    );
  }
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function renderPlan(plan: Plan): string {
  const lines = plan.changes.map(describeChange);
  if (lines.length === 0) lines.push("nothing to change");
  for (const notice of plan.notices) lines.push(`note: ${notice}`);
  return `${lines.join("\n")}\n`;
}

function describeChange(change: Change): string {
  switch (change.kind) {
    case "write":
      return `write   ${change.path} (${Buffer.byteLength(change.content)} bytes)`;
    case "delete":
      return `delete  ${change.path}`;
    case "symlink":
      return `symlink ${change.path} -> ${change.target}`;
    case "unlink":
      return `unlink  ${change.path}`;
    case "mkdir":
      return `mkdir   ${change.path}`;
  }
}

// The `--json` wire format: the plan as two-space-indented JSON with a trailing newline, so a CI
// assertion can diff it byte for byte across runs.
export function planToJson(plan: Plan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
