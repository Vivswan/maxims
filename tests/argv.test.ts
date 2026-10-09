// Fails if a flag given twice stops being refused by any of the eight scripts and resolves to its
// last value again: before parseArgv, `bun scripts/bench.ts --runs 1 --runs 2 -- <child>` ran the
// child twice. Also fails if the refusal stops being exit 2 with the script's own usage before
// anything runs or is written, or if a `--runs` after bench's `--` is read as the bench's own.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdirEnv, withTempDir } from "./shared/temp_dir.ts";

const repoRoot = resolve(import.meta.dir, "..");

function run(script: string, args: string[], dir: string) {
  return Bun.spawnSync(["bun", join(repoRoot, script), ...args], {
    cwd: dir,
    env: { ...process.env, ...tmpdirEnv(dir) },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A child command that leaves a marker in `dir`, so a bench that ran it is visible after the fact. */
function markingChild(dir: string, ...extra: string[]): string[] {
  const child = join(dir, "child.ts");
  writeFileSync(
    child,
    `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "ran"))}, "");\n`,
  );
  return ["bun", child, ...extra];
}

// The bench row is the incident's own spelling; build and arch_lint mix the inline and separate
// spellings, and docs_probe repeats a boolean. Every output path points into the temp cwd, and
// bench_ci's base is a ref no repository holds, so a script that parsed on would write there, run
// the child, or fail later at git with status 1.
const repeated: [script: string, flag: string, args: (dir: string) => string[]][] = [
  [
    "scripts/build.ts",
    "--outfile",
    (dir) => ["--outfile", join(dir, "a.js"), `--outfile=${join(dir, "b.js")}`],
  ],
  [
    "scripts/bench.ts",
    "--runs",
    (dir) => ["--runs", "1", "--runs", "2", "--", ...markingChild(dir)],
  ],
  [
    "scripts/bench_ci.ts",
    "--runs",
    () => ["--base", "refs/heads/argv-test-unresolved", "--runs", "1", "--runs", "2"],
  ],
  [
    "scripts/nightly.ts",
    "--report-dir",
    (dir) => ["harness-drift", "--report-dir", join(dir, "a"), "--report-dir", join(dir, "b")],
  ],
  ["scripts/docs_probe.mts", "--shape-only", () => ["--shape-only", "--shape-only", "README.md"]],
  ["scripts/arch_lint.mts", "--root", () => ["--root", repoRoot, `--root=${repoRoot}`]],
  [
    "scripts/render_architecture_map.mts",
    "--page",
    (dir) => ["--page", join(dir, "a.md"), "--page", join(dir, "b.md")],
  ],
  [
    "scripts/check_architecture_page.mts",
    "--page",
    (dir) => ["--page", join(dir, "a.md"), "--page", join(dir, "b.md")],
  ],
];

test.each(repeated)(
  "%s refuses %s given twice with exit 2 and its usage",
  async (script, flag, args) => {
    await withTempDir((dir) => {
      const argv = args(dir);
      const before = readdirSync(dir).sort();
      const proc = run(script, argv, dir);
      const [message, usage] = proc.stderr.toString().split("\n");
      expect({ exitCode: proc.exitCode, stdout: proc.stdout.toString(), message }).toEqual({
        exitCode: 2,
        stdout: "",
        message: expect.stringMatching(new RegExp(`^(?:[\\w-]+: )?${flag} given twice$`)),
      });
      expect(usage?.startsWith("usage: ")).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(before);
    });
  },
);

test("scripts/bench.ts leaves a --runs after -- to the command", async () => {
  await withTempDir((dir) => {
    const proc = run(
      "scripts/bench.ts",
      ["--runs", "1", "--", ...markingChild(dir, "--runs", "2")],
      dir,
    );
    expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const record = JSON.parse(proc.stdout.toString());
    expect(record.runs).toBe(1);
    expect(record.command.slice(-2)).toEqual(["--runs", "2"]);
    expect(existsSync(join(dir, "ran"))).toBe(true);
  });
});
