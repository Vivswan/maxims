// Guards the property every verb's --dry-run and idempotency claim rests on: a dry run touches
// nothing, and re-applying an already-applied plan counts zero writes.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../tests/shared/temp_dir.ts";
import { applyChanges, type Plan, planToJson, renderPlan } from "./change.ts";
import { ExitCode, type MaximsError } from "./exit-codes.ts";

function planFor(dir: string): Plan {
  return {
    changes: [
      { kind: "mkdir", path: join(dir, "rules") },
      { kind: "write", path: join(dir, "rules", "maxims-a.md"), content: "- rule\n" },
      { kind: "symlink", path: join(dir, "memories", "a.md"), target: join(dir, "store", "a.md") },
      { kind: "unlink", path: join(dir, "old-link.md") },
      { kind: "delete", path: join(dir, "old-rule.md") },
    ],
    notices: ["one notice"],
  };
}

describe("applyChanges", () => {
  test("dry run applies nothing", async () => {
    await withTempDir(async (dir) => {
      const result = await applyChanges(planFor(dir), { dryRun: true });
      expect(result).toEqual({ applied: 0 });
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("applies every kind once, then counts zero on the identical plan", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "old-rule.md"), "stale");
      symlinkSync(join(dir, "nowhere"), join(dir, "old-link.md"));
      const plan = planFor(dir);

      expect(await applyChanges(plan, { dryRun: false })).toEqual({ applied: 5 });
      expect(readFileSync(join(dir, "rules", "maxims-a.md"), "utf8")).toBe("- rule\n");
      expect(readlinkSync(join(dir, "memories", "a.md"))).toBe(join(dir, "store", "a.md"));
      expect(existsSync(join(dir, "old-rule.md"))).toBe(false);
      expect(lstatSync(join(dir, "old-link.md"), { throwIfNoEntry: false })).toBeUndefined();

      expect(await applyChanges(plan, { dryRun: false })).toEqual({ applied: 0 });
    });
  });

  test("a changed symlink target is repointed; a real file in its place is refused", async () => {
    await withTempDir(async (dir) => {
      const link = join(dir, "a.md");
      symlinkSync(join(dir, "old"), link);
      const repoint: Plan = {
        changes: [{ kind: "symlink", path: link, target: join(dir, "new") }],
        notices: [],
      };
      expect(await applyChanges(repoint, { dryRun: false })).toEqual({ applied: 1 });
      expect(readlinkSync(link)).toBe(join(dir, "new"));

      const real = join(dir, "real.md");
      writeFileSync(real, "user content");
      for (const change of [
        { kind: "symlink", path: real, target: join(dir, "new") } as const,
        { kind: "unlink", path: real } as const,
      ]) {
        let caught: unknown;
        try {
          await applyChanges({ changes: [change], notices: [] }, { dryRun: false });
        } catch (error) {
          caught = error;
        }
        expect((caught as MaximsError).code).toBe(ExitCode.DestinationWriteFailed);
        expect(readFileSync(real, "utf8")).toBe("user content");
      }
    });
  });

  test("delete removes a directory tree but only unlinks a symlink to one", async () => {
    await withTempDir(async (dir) => {
      const tree = join(dir, "tree");
      mkdirSync(join(tree, "sub"), { recursive: true });
      writeFileSync(join(tree, "sub", "f"), "");
      const link = join(dir, "link");
      symlinkSync(tree, link);
      expect(
        await applyChanges(
          { changes: [{ kind: "delete", path: link }], notices: [] },
          { dryRun: false },
        ),
      ).toEqual({ applied: 1 });
      expect(existsSync(join(tree, "sub", "f"))).toBe(true);
      expect(
        await applyChanges(
          { changes: [{ kind: "delete", path: tree }], notices: [] },
          { dryRun: false },
        ),
      ).toEqual({ applied: 1 });
      expect(existsSync(tree)).toBe(false);
    });
  });
});

test("renderPlan and planToJson describe the same plan for humans and for --json", () => {
  const plan = planFor("/home/user/project");
  expect(renderPlan(plan)).toBe(
    [
      "mkdir   /home/user/project/rules",
      "write   /home/user/project/rules/maxims-a.md (7 bytes)",
      "symlink /home/user/project/memories/a.md -> /home/user/project/store/a.md",
      "unlink  /home/user/project/old-link.md",
      "delete  /home/user/project/old-rule.md",
      "note: one notice",
      "",
    ].join("\n"),
  );
  expect(renderPlan({ changes: [], notices: [] })).toBe("nothing to change\n");
  expect(JSON.parse(JSON.stringify(planToJson(plan)))).toEqual(plan);
});
