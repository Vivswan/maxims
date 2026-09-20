import { lstat, mkdir, readFile, readlink, rm, symlink, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { ExitCode, MaximsError } from "./exit-codes.ts";
import { writeFileAtomic } from "./fs.ts";

export type Change =
  | { kind: "write"; path: string; content: string; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "symlink"; path: string; target: string }
  | { kind: "unlink"; path: string }
  | { kind: "mkdir"; path: string };

export type Plan = {
  changes: Change[];
  notices: string[];
};

export type ApplyOptions = {
  dryRun: boolean;
};

export type ApplyResult = {
  applied: number;
};

// `unlink` and `symlink` refuse a real file or directory at the path: the only thing maxims may
// replace without an explicit `delete` in the plan is a link it could have written itself.
export async function applyChanges(plan: Plan, options: ApplyOptions): Promise<ApplyResult> {
  if (options.dryRun) return { applied: 0 };
  let applied = 0;
  for (const change of plan.changes) {
    if (await applyOne(change)) applied += 1;
  }
  return { applied };
}

async function applyOne(change: Change): Promise<boolean> {
  switch (change.kind) {
    case "write": {
      const existing = await readFile(change.path, "utf8").catch(() => null);
      if (existing === change.content) return false;
      writeFileAtomic(change.path, change.content, { mode: change.mode });
      return true;
    }
    case "delete": {
      const entry = await lstat(change.path).catch(() => null);
      if (entry === null) return false;
      await guarded(change.path, () =>
        entry.isSymbolicLink() ? unlink(change.path) : rm(change.path, { recursive: true }),
      );
      return true;
    }
    case "symlink": {
      const entry = await lstat(change.path).catch(() => null);
      if (entry !== null) {
        if (!entry.isSymbolicLink()) {
          throw new MaximsError(
            ExitCode.DestinationWriteFailed,
            `refusing to replace ${change.path} with a symlink: it is not a symlink`,
          );
        }
        if ((await readlink(change.path)) === change.target) return false;
        await guarded(change.path, () => unlink(change.path));
      }
      await guarded(change.path, async () => {
        await mkdir(dirname(change.path), { recursive: true });
        await symlink(change.target, change.path);
      });
      return true;
    }
    case "unlink": {
      const entry = await lstat(change.path).catch(() => null);
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
      const entry = await lstat(change.path).catch(() => null);
      if (entry?.isDirectory()) return false;
      await guarded(change.path, () => mkdir(change.path, { recursive: true }));
      return true;
    }
  }
}

async function guarded(path: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new MaximsError(ExitCode.DestinationWriteFailed, `cannot update ${path}: ${detail}`, {
      cause,
    });
  }
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

export type PlanJson = {
  changes: Change[];
  notices: string[];
};

// The `--json` shape is the plan itself; naming the conversion keeps the CLI's output contract in
// one place should the wire shape ever diverge from the in-memory one.
export function planToJson(plan: Plan): PlanJson {
  return { changes: plan.changes.map((change) => ({ ...change })), notices: [...plan.notices] };
}
