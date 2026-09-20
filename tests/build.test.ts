// Fails if the published artifact stops being a self-contained node executable: a lost or doubled
// shebang, a dropped exec bit, a stray node_modules reference, or a size line that lies would all
// ship silently, since nothing in the repo runs dist/cli.js under plain node except this test.
// Also fails if relative --outfile and --size-json paths stop landing where the caller stands,
// which the repo-root chdir inside the build would otherwise move without a word.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version.ts";

const repoRoot = resolve(import.meta.dir, "..");
const SHEBANG = "#!/usr/bin/env node\n";

interface Invocation {
  cwd: string;
  outfileArg: string;
  sizeJsonArg: string;
  outfile: string;
  sizeJson: string;
}

const invocations: [string, (dir: string) => Invocation][] = [
  [
    "absolute paths from the repo root",
    (dir) => ({
      cwd: repoRoot,
      outfileArg: join(dir, "cli.js"),
      sizeJsonArg: join(dir, "size.json"),
      outfile: join(dir, "cli.js"),
      sizeJson: join(dir, "size.json"),
    }),
  ],
  [
    "relative paths from a cwd outside the repo",
    (dir) => ({
      cwd: dir,
      outfileArg: join("out", "cli.js"),
      sizeJsonArg: join("report", "size.json"),
      outfile: join(dir, "out", "cli.js"),
      sizeJson: join(dir, "report", "size.json"),
    }),
  ],
];

test.each(invocations)(
  "bun scripts/build.ts with %s writes an executable single-file bundle that runs under node",
  (_name, invocation) => {
    const dir = mkdtempSync(join(tmpdir(), "maxims-build-"));
    try {
      const { cwd, outfileArg, sizeJsonArg, outfile, sizeJson } = invocation(dir);
      const build = Bun.spawnSync(
        [
          "bun",
          join(repoRoot, "scripts", "build.ts"),
          "--outfile",
          outfileArg,
          "--size-json",
          sizeJsonArg,
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      expect(build.stderr.toString()).toBe("");
      expect(build.exitCode).toBe(0);

      const bytes = statSync(outfile).size;
      expect(build.stdout.toString()).toBe(`bundle: ${outfileArg} ${bytes} bytes\n`);
      expect(JSON.parse(readFileSync(sizeJson, "utf8"))).toEqual({ bytes });

      const text = readFileSync(outfile, "utf8");
      expect(text.startsWith(SHEBANG)).toBe(true);
      expect(text.slice(SHEBANG.length).startsWith("#!")).toBe(false);
      expect(text).not.toContain("node_modules");
      expect(statSync(outfile).mode & 0o111).toBe(0o111);

      const run = Bun.spawnSync(["node", outfile], { stdout: "pipe", stderr: "pipe" });
      expect(run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toBe(`maxims ${VERSION}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
