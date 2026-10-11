// Guards the property every verb's --dry-run and idempotency claim rests on: a dry run touches
// nothing, re-applying an already-applied plan counts zero writes, and a probe that could not
// look never reads as "already done". Also the two readings of a symlink at a destination: a
// `write` (a file maxims owns whole) replaces it, an `edit` (a user's file) goes through it.
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
import { applyChanges, editInPlace, type Plan, renderPlan } from "../../src/util/change.ts";
import { ExitCode, MaximsError } from "../../src/util/exit-codes.ts";
import { assertInsideRoot, type RootedPath } from "../../src/util/fs.ts";
import { CHMOD_DENIES, WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";

function planFor(dir: string): Plan {
  const rooted = (...parts: string[]) => assertInsideRoot(dir, join(dir, ...parts));
  return {
    changes: [
      { kind: "mkdir", path: rooted("rules") },
      { kind: "write", path: rooted("rules", "maxims-a.md"), content: "- rule\n" },
      editInPlace(dir, rooted("AGENTS.md"))("# Mine\n"),
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
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Mine\n");
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

  // A settings.json or AGENTS.md kept in a dotfiles checkout: the link is the user's setup, and
  // the hook or block must land in the file it points to.
  test("an edit through a symlink lands in the target and the link survives", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, "dotfiles"));
      const real = join(dir, "dotfiles", "settings.json");
      writeFileSync(real, "{}\n");
      const link = assertInsideRoot(dir, join(dir, "settings.json"));
      symlinkSync(real, link);
      const content = '{ "hooks": [] }\n';
      const edit = editInPlace(dir, link)(content);
      expect(edit).toEqual({
        kind: "edit",
        path: link,
        target: assertInsideRoot(dir, real),
        content,
      });
      const plan: Plan = { changes: [edit], notices: [] };
      expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(1);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(real);
      expect(readFileSync(real, "utf8")).toBe(content);
      expect(readdirSync(join(dir, "dotfiles"))).toEqual(["settings.json"]);
      expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(0);
    });
  });

  // A private registry (0600) stays private after the edit: the file is the user's, and the
  // write beside the target opens its temp file with the default mode.
  test.skipIf(WINDOWS)("an edit keeps the mode of the file it lands in", async () => {
    await withTempDir(async (dir) => {
      const direct = assertInsideRoot(dir, join(dir, "direct.json"));
      writeFileSync(direct, "{}\n", { mode: 0o600 });
      const real = join(dir, "real.json");
      writeFileSync(real, "{}\n", { mode: 0o600 });
      const link = assertInsideRoot(dir, join(dir, "link.json"));
      symlinkSync(real, link);
      const plan: Plan = {
        changes: [editInPlace(dir, direct)("{ }\n"), editInPlace(dir, link)("{ }\n")],
        notices: [],
      };
      expect((await applyChanges(plan, { dryRun: false })).applied).toHaveLength(2);
      expect([statSync(direct).mode & 0o777, statSync(real).mode & 0o777]).toEqual([0o600, 0o600]);
    });
  });

  // Each is a link only the user can repoint, so the plan refuses before anything is written and
  // the message names the link and the fix.
  const unfollowable: [string, (dir: string) => string, RegExp][] = [
    ["a dangling link", (dir) => join(dir, "root", "gone.json"), /does not exist/],
    [
      "a link to a directory",
      (dir) => {
        mkdirSync(join(dir, "root", "folder"));
        return join(dir, "root", "folder");
      },
      /is not a file/,
    ],
    [
      "a link out of the root",
      (dir) => {
        mkdirSync(join(dir, "elsewhere"));
        writeFileSync(join(dir, "elsewhere", "settings.json"), "{}\n");
        return join(dir, "elsewhere", "settings.json");
      },
      /outside/,
    ],
  ];
  test.each(unfollowable)(
    "an edit through %s is refused with the link and the fix, nothing written",
    async (_label, plant, reason) => {
      await withTempDir(async (dir) => {
        const root = join(dir, "root");
        mkdirSync(root);
        const link = assertInsideRoot(root, join(root, "settings.json"));
        symlinkSync(plant(dir), link);
        const before = [readdirSync(root).sort(), readdirSync(dir).sort()];
        let caught: unknown;
        try {
          editInPlace(root, link);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(MaximsError);
        const refusal = caught as MaximsError;
        expect(refusal.code).toBe(ExitCode.DestinationWriteFailed);
        expect(refusal.message).toContain(`cannot edit ${link}`);
        expect(refusal.message).toMatch(reason);
        expect(refusal.hint).toContain("maxims sync");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect([readdirSync(root).sort(), readdirSync(dir).sort()]).toEqual(before);
      });
    },
  );

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

test("renderPlan describes the plan for humans, one line per change", () => {
  const project = resolve("/home/user/project");
  const at = (...parts: string[]) => join(project, ...parts);
  const plan = planFor(project);
  expect(renderPlan(plan)).toBe(
    [
      `mkdir   ${at("rules")}`,
      `write   ${at("rules", "maxims-a.md")} (7 bytes)`,
      `edit    ${at("AGENTS.md")} (7 bytes)`,
      `symlink ${at("memories", "a.md")} -> ${at("store", "a.md")}`,
      `unlink  ${at("old-link.md")}`,
      `delete  ${at("old-rule.md")}`,
      "note: one notice",
      "",
    ].join("\n"),
  );
  expect(renderPlan({ changes: [], notices: [] })).toBe("nothing to change\n");
  // The one line a dry run has to say where a linked user file is really edited.
  const through: Plan = {
    changes: [
      {
        kind: "edit",
        path: at("settings.json") as RootedPath,
        target: at("dotfiles", "settings.json") as RootedPath,
        content: "{}\n",
      },
    ],
    notices: [],
  };
  expect(renderPlan(through)).toBe(
    `edit    ${at("settings.json")} -> ${at("dotfiles", "settings.json")} (3 bytes)\n`,
  );
});
