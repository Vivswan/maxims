// Fails if the version the built cli prints stops being the one package.json carried when it was bundled. The publish
// lanes check the same equality right before npm publish; this test catches a bundle that bakes its version in from
// anywhere else before a green push ever reaches them.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import manifest from "../../package.json" with { type: "json" };
import { withTempDir } from "../shared/temp_dir.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const VERSION = "9.9.9-main.7.20260920.gabcdef0";

function repoCopyAt(root: string, version: string): void {
  for (const entry of ["src", "scripts", "tsconfig.json"]) {
    cpSync(join(REPO, entry), join(root, entry), { recursive: true });
  }
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  );
}

test("the bundle prints the version package.json carried at build time", async () => {
  await withTempDir((root) => {
    repoCopyAt(root, VERSION);
    const run = (file: string, args: string[]): string =>
      execFileSync(file, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    run("bun", ["run", "build"]);
    expect(run("node", [join(root, "dist", "cli.js"), "--version"])).toBe(`maxims ${VERSION}\n`);
  });
});
