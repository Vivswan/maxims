// Guards the local source's store shape: two dirs sharing a basename landing in one entry, a live
// source copied instead of linked, or a link removal reaching the target would each pass a sync.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withTempDir, withTempHome } from "../../tests/shared/temp_dir.ts";
import { applyChanges } from "../util/change.ts";
import { homePaths } from "../util/home.ts";
import { createLocalResolver, materializeLocal } from "./local.ts";

const MEMORY = "---\nname: a-rule\ndescription: A rule.\n---\n\nBody.\n";

function seedSource(dir: string): void {
  mkdirSync(join(dir, "memories"), { recursive: true });
  writeFileSync(join(dir, "memories", "a-rule.md"), MEMORY);
}

describe("createLocalResolver", () => {
  test("hashes the memory set so an edit changes the sha and an unrelated file does not", async () => {
    await withTempDir(async (dir) => {
      seedSource(dir);
      const resolver = createLocalResolver(() => {});
      const opts = { memoryPath: "memories", fullDepth: false, tempDir: dir };
      const from = { type: "local" as const, path: dir };
      const first = await resolver.fetch(from, opts);
      expect(first.memoryPath).toBe("memories");
      expect(first.files).toEqual([{ relPath: "memories/a-rule.md", text: MEMORY }]);
      writeFileSync(join(dir, "memories", "notes.txt"), "unrelated\n");
      expect((await resolver.fetch(from, opts)).sha).toBe(first.sha);
      writeFileSync(join(dir, "memories", "a-rule.md"), `${MEMORY}edited\n`);
      expect((await resolver.fetch(from, opts)).sha).not.toBe(first.sha);
    });
  });
});

describe("materializeLocal", () => {
  test("two sources with the same basename get distinct copied entries under _local", async () => {
    await withTempHome(async (home) => {
      await withTempDir(async (dir) => {
        const a = join(dir, "dotfiles", "memories");
        const b = join(dir, "work", "memories");
        const files = [{ relPath: "memories/a-rule.md", text: MEMORY }];
        const planA = materializeLocal({ type: "local", path: a }, home, files);
        const planB = materializeLocal({ type: "local", path: b }, home, files);
        const store = homePaths(home).store;
        expect(planA.map((c) => c.kind)).toEqual(["delete", "mkdir", "write"]);
        expect(planA[0]?.path).toMatch(
          new RegExp(`^${join(store, "_local", "memories-")}[0-9a-f]{8}$`),
        );
        expect(planA[0]?.path).not.toBe(planB[0]?.path);
        await applyChanges({ changes: [...planA, ...planB], notices: [] }, { dryRun: false });
        const written = [planA[2], planB[2]].map((c) =>
          c === undefined ? "" : readFileSync(c.path, "utf8"),
        );
        expect(written).toEqual([MEMORY, MEMORY]);
        expect(lstatSync(planA[0]?.path ?? "").isSymbolicLink()).toBe(false);
      });
    });
  });

  test("re-materializing replaces the entry: a dropped memory disappears and live can flip either way", async () => {
    await withTempHome(async (home) => {
      await withTempDir(async (dir) => {
        seedSource(dir);
        const copied = { type: "local" as const, path: dir };
        const live = { type: "local" as const, path: dir, live: true };
        const both = [
          { relPath: "memories/a-rule.md", text: MEMORY },
          { relPath: "memories/b-rule.md", text: MEMORY },
        ];
        const apply = (changes: ReturnType<typeof materializeLocal>) =>
          applyChanges({ changes, notices: [] }, { dryRun: false });
        await apply(materializeLocal(copied, home, both));
        const entry = materializeLocal(copied, home, both)[0]?.path ?? "";
        expect(readdirSync(join(entry, "memories")).sort()).toEqual(["a-rule.md", "b-rule.md"]);
        await apply(materializeLocal(copied, home, both.slice(0, 1)));
        expect(readdirSync(join(entry, "memories"))).toEqual(["a-rule.md"]);
        await apply(materializeLocal(live, home, []));
        expect(readlinkSync(entry)).toBe(dir);
        await apply(materializeLocal(copied, home, both.slice(0, 1)));
        expect(lstatSync(entry).isSymbolicLink()).toBe(false);
        expect(readdirSync(join(entry, "memories"))).toEqual(["a-rule.md"]);
        expect(readdirSync(join(dir, "memories"))).toEqual(["a-rule.md"]);
      });
    });
  });

  test("a live source is one symlink whose removal leaves the target byte-identical", async () => {
    await withTempHome(async (home) => {
      await withTempDir(async (dir) => {
        seedSource(dir);
        const plan = materializeLocal({ type: "local", path: dir, live: true }, home, []);
        const entry = plan[0]?.path ?? "";
        expect(entry).toMatch(/_local\/[^/]+-[0-9a-f]{8}$/);
        expect(plan).toEqual([
          { kind: "delete", path: entry },
          { kind: "symlink", path: entry, target: dir },
        ]);
        await applyChanges({ changes: plan, notices: [] }, { dryRun: false });
        expect(readlinkSync(entry)).toBe(dir);
        expect(readFileSync(join(entry, "memories", "a-rule.md"), "utf8")).toBe(MEMORY);
        await applyChanges(
          { changes: [{ kind: "unlink", path: entry }], notices: [] },
          { dryRun: false },
        );
        expect(existsSync(entry)).toBe(false);
        expect(readFileSync(join(dir, "memories", "a-rule.md"), "utf8")).toBe(MEMORY);
      });
    });
  });
});
