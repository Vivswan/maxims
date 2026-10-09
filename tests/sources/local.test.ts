// Guards the local source's plan: a sha moved by a file that is not a memory, an entry deleted
// before it exists, or a re-materialization that merges into the old entry instead of replacing
// it would each pass a sync. The store path itself is tests/util/home.test.ts's pin.
import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLocalResolver, materializeLocal } from "../../src/sources/local.ts";
import { applyChanges } from "../../src/util/change.ts";
import { withTempDir, withTempHome } from "../shared/temp_dir.ts";

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
      const opts = { memoryPath: "memories", fullDepth: false, tempDir: dir, auth: false };
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
  // The plan is what the run would do: a first install has no entry to replace, so it plans no
  // deletion, and a dry run of it shows none; a second materialization replaces the entry whole.
  test("the entry's deletion is planned only once the entry exists", async () => {
    await withTempHome(async (home) => {
      await withTempDir(async (dir) => {
        seedSource(dir);
        const copied = { type: "local" as const, path: dir };
        const files = [{ relPath: "memories/a-rule.md", text: MEMORY }];
        const first = materializeLocal(copied, home, files);
        expect(first.map((c) => c.kind)).toEqual(["mkdir", "write"]);
        await applyChanges({ changes: first, notices: [] }, { dryRun: false });
        const entry = first[0]?.path ?? "";
        expect(materializeLocal(copied, home, files)).toEqual([
          { kind: "delete", path: entry },
          ...first,
        ]);
        expect(materializeLocal({ ...copied, live: true }, home, []).map((c) => c.kind)).toEqual([
          "delete",
          "symlink",
        ]);
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
        expect(readFileSync(join(entry, "memories", "b-rule.md"), "utf8")).toBe(MEMORY);
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
});
