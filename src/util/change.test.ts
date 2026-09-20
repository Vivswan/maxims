// Guards the property every verb's --dry-run and idempotency claim rests on: a dry run touches
// nothing, re-applying an already-applied plan counts zero writes, and a probe that could not
// look never reads as "already done".
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CHMOD_DENIES, WINDOWS } from "../../tests/shared/platform.ts";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { applyChanges, type Plan, planToJson, renderPlan } from "./change.ts";
import { ExitCode, type MaximsError } from "./exit-codes.ts";
import { assertInsideRoot } from "./fs.ts";

function planFor(dir: string): Plan {
  const rooted = (...parts: string[]) => assertInsideRoot(dir, join(dir, ...parts));
  return {
    changes: [
      { kind: "mkdir", path: rooted("rules") },
      { kind: "write", path: rooted("rules", "maxims-a.md"), content: "- rule\n" },
      { kind: "symlink", path: rooted("memories", "a.md"), target: join(dir, "store", "a.md") },
      { kind: "unlink", path: rooted("old-link.md") },
      { kind: "delete", path: rooted("old-rule.md") },
    ],
    notices: ["one notice"],
  };
}

async function expectWriteFailed(action: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
}

describe("applyChanges", () => {
  test("dry run applies nothing", async () => {
    await withTempDir(async (dir) => {
      const result = await applyChanges(planFor(dir), { dryRun: true });
      expect(result).toEqual({ applied: [] });
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("applies every kind once, then counts zero on the identical plan", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "old-rule.md"), "stale");
      symlinkSync(join(dir, "nowhere"), join(dir, "old-link.md"));
      const plan = planFor(dir);

      expect((await applyChanges(plan, { dryRun: false })).applied).toEqual(plan.changes);
      expect(readFileSync(join(dir, "rules", "maxims-a.md"), "utf8")).toBe("- rule\n");
      expect(readlinkSync(join(dir, "memories", "a.md"))).toBe(join(dir, "store", "a.md"));
      expect(existsSync(join(dir, "old-rule.md"))).toBe(false);
      expect(lstatSync(join(dir, "old-link.md"), { throwIfNoEntry: false })).toBeUndefined();

      expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(0);
    });
  });

  // Windows has no mode bits.
  test.skipIf(WINDOWS)(
    "identical content with a different requested mode is a mode change, counted once",
    async () => {
      await withTempDir(async (dir) => {
        const path = assertInsideRoot(dir, join(dir, "hook.sh"));
        writeFileSync(path, "#!/bin/sh\n", { mode: 0o644 });
        const plan: Plan = {
          changes: [{ kind: "write", path, content: "#!/bin/sh\n", mode: 0o755 }],
          notices: [],
        };
        expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(1);
        expect(statSync(path).mode & 0o777).toBe(0o755);
        expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(0);
      });
    },
  );

  test.skipIf(!WINDOWS)(
    "on windows a requested mode never makes an identical file a change",
    async () => {
      await withTempDir(async (dir) => {
        const path = assertInsideRoot(dir, join(dir, "hook.sh"));
        writeFileSync(path, "#!/bin/sh\n");
        const plan: Plan = {
          changes: [{ kind: "write", path, content: "#!/bin/sh\n", mode: 0o755 }],
          notices: [],
        };
        expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(0);
        expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(0);
      });
    },
  );

  test("a write over a symlink with identical bytes still replaces it with a real file", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store.md");
      writeFileSync(store, "- rule\n");
      const rule = assertInsideRoot(dir, join(dir, "rule.md"));
      symlinkSync(store, rule);
      const plan: Plan = {
        changes: [{ kind: "write", path: rule, content: "- rule\n" }],
        notices: [],
      };
      expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(1);
      expect(lstatSync(rule).isSymbolicLink()).toBe(false);
      expect(readFileSync(rule, "utf8")).toBe("- rule\n");
      expect(readFileSync(store, "utf8")).toBe("- rule\n");
      expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(0);
    });
  });

  test("a changed symlink target is repointed; a real file in its place is refused", async () => {
    await withTempDir(async (dir) => {
      const link = assertInsideRoot(dir, join(dir, "a.md"));
      symlinkSync(join(dir, "old"), link);
      const repoint: Plan = {
        changes: [{ kind: "symlink", path: link, target: join(dir, "new") }],
        notices: [],
      };
      expect((await applyChanges(repoint, { dryRun: false })).applied).toHaveLength(1);
      expect(readlinkSync(link)).toBe(join(dir, "new"));

      const real = assertInsideRoot(dir, join(dir, "real.md"));
      writeFileSync(real, "user content");
      for (const change of [
        { kind: "symlink", path: real, target: join(dir, "new") } as const,
        { kind: "unlink", path: real } as const,
      ]) {
        await expectWriteFailed(() =>
          applyChanges({ changes: [change], notices: [] }, { dryRun: false }),
        );
        expect(readFileSync(real, "utf8")).toBe("user content");
      }
    });
  });

  test("mkdir over a link to an existing directory is not a change", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "alias"));
      const plan: Plan = {
        changes: [{ kind: "mkdir", path: assertInsideRoot(dir, join(dir, "alias")) }],
        notices: [],
      };
      expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(0);
    });
  });

  test("delete removes a directory tree but only unlinks a symlink to one", async () => {
    await withTempDir(async (dir) => {
      const tree = assertInsideRoot(dir, join(dir, "tree"));
      mkdirSync(join(tree, "sub"), { recursive: true });
      writeFileSync(join(tree, "sub", "f"), "");
      const link = assertInsideRoot(dir, join(dir, "link"));
      symlinkSync(tree, link);
      const unlinked = await applyChanges(
        { changes: [{ kind: "delete", path: link }], notices: [] },
        { dryRun: false },
      );
      expect(unlinked.applied).toHaveLength(1);
      expect(existsSync(join(tree, "sub", "f"))).toBe(true);
      const removed = await applyChanges(
        { changes: [{ kind: "delete", path: tree }], notices: [] },
        { dryRun: false },
      );
      expect(removed.applied).toHaveLength(1);
      expect(existsSync(tree)).toBe(false);
    });
  });

  test.skipIf(!CHMOD_DENIES)(
    "a path that cannot be inspected is exit 4, never a silent no-op",
    async () => {
      await withTempDir(async (dir) => {
        const unreadable = assertInsideRoot(dir, join(dir, "unreadable.md"));
        writeFileSync(unreadable, "secret", { mode: 0o000 });
        await expectWriteFailed(() =>
          applyChanges(
            { changes: [{ kind: "write", path: unreadable, content: "y" }], notices: [] },
            { dryRun: false },
          ),
        );
        const sealed = join(dir, "sealed");
        mkdirSync(sealed);
        writeFileSync(join(sealed, "x.md"), "");
        const target = assertInsideRoot(dir, join(sealed, "x.md"));
        chmodSync(sealed, 0o000);
        try {
          for (const change of [
            { kind: "delete", path: target } as const,
            { kind: "unlink", path: target } as const,
            { kind: "write", path: target, content: "y" } as const,
          ]) {
            await expectWriteFailed(() =>
              applyChanges({ changes: [change], notices: [] }, { dryRun: false }),
            );
          }
        } finally {
          chmodSync(sealed, 0o700);
        }
      });
    },
  );
});

test("renderPlan and planToJson describe the same plan for humans and for --json", () => {
  const project = resolve("/home/user/project");
  const at = (...parts: string[]) => join(project, ...parts);
  const plan = planFor(project);
  expect(renderPlan(plan)).toBe(
    [
      `mkdir   ${at("rules")}`,
      `write   ${at("rules", "maxims-a.md")} (7 bytes)`,
      `symlink ${at("memories", "a.md")} -> ${at("store", "a.md")}`,
      `unlink  ${at("old-link.md")}`,
      `delete  ${at("old-rule.md")}`,
      "note: one notice",
      "",
    ].join("\n"),
  );
  expect(renderPlan({ changes: [], notices: [] })).toBe("nothing to change\n");
  const json = planToJson(plan);
  expect(json.endsWith("\n")).toBe(true);
  expect(json.split("\n")[1]).toBe('  "changes": [');
  expect(JSON.parse(json)).toEqual(plan);
});
