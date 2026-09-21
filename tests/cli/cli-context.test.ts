// Fails if `updateIntent` writes a state document the state parser would refuse: a value that
// reached the `State` type without passing the schema (a ref carrying `-->`) would land on disk
// and quarantine the whole file, every source with it, on the next read.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { updateIntent } from "../../src/commands/shared/cli-context.ts";
import { emptyState, parseState, type State } from "../../src/state/schema.ts";
import { WRITTEN_BY } from "../../src/state/store.ts";
import { MaximsError } from "../../src/util/exit-codes.ts";
import { homePaths } from "../../src/util/home.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const withBadRef = (): State => ({
  ...emptyState(WRITTEN_BY),
  sources: {
    "@a/b#release-->v1": {
      intent: {
        from: { type: "github", repo: "a/b", ref: "release-->v1" },
        select: "*",
        rename: {},
        rule: false,
        destination: { scope: "global" },
        copy: false,
        auth: false,
        harnesses: [],
        memoryPath: "memories",
        fullDepth: false,
      },
      addedAt: "2026-09-20T12:00:00.000Z",
    },
  },
});

const dryRuns: [boolean][] = [[false], [true]];

test.each(dryRuns)(
  "updateIntent refuses a state that would not read back (dryRun %p)",
  async (dryRun) => {
    await withTempDir(async (root) => {
      const home = join(root, "maxims");
      mkdirSync(home);
      let applied = 0;
      const attempt = updateIntent(
        home,
        dryRun,
        async () => ({ state: withBadRef(), changes: [], notices: [] }),
        async () => {
          applied += 1;
        },
      );
      await expect(attempt).rejects.toBeInstanceOf(MaximsError);
      await attempt.catch((error: MaximsError) => {
        expect(error.code).toBe(1);
        expect(error.message).toContain("refusing to write");
        expect(error.message).toContain(
          "sources.@a/b#release-->v1.intent.from.ref: a ref cannot contain -->",
        );
      });
      expect(applied).toBe(0);
      expect(existsSync(homePaths(home).state)).toBe(false);
    });
  },
);

test("updateIntent writes a state that reads back", async () => {
  await withTempDir(async (root) => {
    const home = join(root, "maxims");
    mkdirSync(home);
    const update = await updateIntent(
      home,
      false,
      async () => ({
        state: { ...emptyState(WRITTEN_BY), hooks: { global: ["codex"] } },
        changes: [],
        notices: [],
      }),
      async () => undefined,
    );
    const [write] = update.changes;
    if (write?.kind !== "write") throw new Error("expected the state write in the plan");
    const bytes = readFileSync(homePaths(home).state, "utf8");
    expect(write.content).toBe(bytes);
    const stored = parseState(JSON.parse(bytes));
    expect(stored).toMatchObject({
      ok: "parsed",
      state: { hooks: { global: ["codex"] }, sources: {} },
    });
  });
});
