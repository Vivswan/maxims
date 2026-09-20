// Fails if the bundle a user installs stops answering its usage surface the way the shell sees
// it, or starts writing into the home on a help request or a usage error, while the in-process
// CLI tests stay green: the build test asks the built artifact only for its version.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../src/util/fs.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import { type Bundle, buildBundle, makeHome, runMaxims } from "./binary.ts";
import { snapshot } from "./fixtures.ts";

let bundleDir = "";
let bundle: Bundle;

beforeAll(() => {
  const home = process.env.HOME;
  if (home === undefined) throw new Error("the test launcher must set HOME");
  bundleDir = mkdtempSync(join(home, "maxims-e2e-bundle-"));
  bundle = buildBundle(bundleDir);
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

type UsageRow = [argv: string[], code: number, stderr: string];

const usageRows: UsageRow[] = [
  [["--help"], 0, ""],
  [["add", "--help"], 0, ""],
  [["frob"], 1, " ERROR  Unknown command: frob\nTip: Run maxims --help for usage.\n"],
  [["add"], 1, " ERROR  Missing required argument: source\n"],
];

test.each(usageRows)(
  "8: maxims %j exits %i and leaves the home untouched",
  async (argv, code, stderr) => {
    await withTempDir(async (dir) => {
      const home = makeHome(dir);
      const before = snapshot(home.root);
      const run = await runMaxims(bundle, home, argv);
      expect({ code: run.code, stderr: run.stderr }).toEqual({ code, stderr });
      expect(run.stdout.length > 0).toBe(code === 0);
      expect(snapshot(home.root)).toEqual(before);
    });
  },
);

// The control for every "nothing written" row: the snapshot must see the three kinds of entry
// a run could leave behind, or an unconditional empty map would pass them all.
test("the home snapshot names a new empty directory, file and symlink", async () => {
  await withTempDir(async (dir) => {
    const home = makeHome(dir);
    const before = snapshot(home.root);
    mkdirSync(join(home.root, ".claude", "rules"), { recursive: true });
    mkdirSync(join(home.root, ".codex"));
    writeFileSync(join(home.root, ".claude", "rules", "maxims-x.md"), "- a rule\n");
    symlinkSync("/dev/null", join(home.root, ".claude", "link"));
    const after = snapshot(home.root);
    for (const key of before.keys()) after.delete(key);
    expect([...after.entries()].sort()).toEqual([
      [".claude", "dir"],
      [".claude/link", "link:/dev/null"],
      [".claude/rules", "dir"],
      [".claude/rules/maxims-x.md", sha256("- a rule\n")],
      [".codex", "dir"],
    ]);
  });
});
