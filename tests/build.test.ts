// Fails if the published artifact stops being a self-contained node executable: a lost or doubled
// shebang, a dropped exec bit, a stray node_modules reference, or a size line that lies would all
// ship silently, since nothing in the repo runs dist/cli.js under plain node except this test.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const SHEBANG = "#!/usr/bin/env node\n";

test("bun scripts/build.ts writes an executable single-file bundle that runs under node", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-build-"));
  try {
    const out = join(dir, "cli.js");
    const sizeJson = join(dir, "size.json");
    const build = Bun.spawnSync(
      ["bun", "scripts/build.ts", "--outfile", out, "--size-json", sizeJson],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);

    const bytes = statSync(out).size;
    expect(build.stdout.toString()).toBe(`bundle: ${out} ${bytes} bytes\n`);
    expect(JSON.parse(readFileSync(sizeJson, "utf8"))).toEqual({ bytes });

    const text = readFileSync(out, "utf8");
    expect(text.startsWith(SHEBANG)).toBe(true);
    expect(text.slice(SHEBANG.length).startsWith("#!")).toBe(false);
    expect(text).not.toContain("node_modules");
    expect(statSync(out).mode & 0o111).toBe(0o111);

    const run = Bun.spawnSync(["node", out], { stdout: "pipe", stderr: "pipe" });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("maxims 0.0.0\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
