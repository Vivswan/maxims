// Fails if the published artifact stops being a self-contained node executable: a lost or doubled
// shebang, a dropped exec bit, a stray node_modules reference, or a size line that lies would all
// ship silently, since nothing in the repo runs dist/cli.js under plain node except this test.
// Also fails if relative --entry, --outfile, and --size-json paths stop landing where the caller
// stands, which the repo-root chdir inside the build would otherwise move without a word, if one
// path given for both lets the size report overwrite the bundle, or if a bundle that fails to
// build stops reporting the bundler's message and a non-zero exit.
import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { VERSION } from "../src/version.ts";

const repoRoot = resolve(import.meta.dir, "..");
const buildScript = join(repoRoot, "scripts", "build.ts");
const SHEBANG = "#!/usr/bin/env node\n";
const USAGE = "usage: bun scripts/build.ts [--entry path] [--outfile path] [--size-json path]\n";

function runBuild(args: string[], cwd: string) {
  return Bun.spawnSync(["bun", buildScript, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

interface Invocation {
  cwd: string;
  outfileArg: string;
  sizeJsonArg: string;
  outfile: string;
  sizeJson: string;
  // Paths inside the repository a build that resolves after the chdir would write instead.
  strays: string[];
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
      strays: [],
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
      strays: [join(repoRoot, "out", "cli.js"), join(repoRoot, "report", "size.json")],
    }),
  ],
];

// A red run of the relative case writes into the checkout. The shallowest missing ancestor of each
// path is what such a run would create, and removing it afterwards takes everything under it along
// without touching what was already there. Descent stops at an entry that is not a directory, so a
// stray file or a dangling link is neither probed beneath nor removed.
function removerOfCreated(paths: string[]): () => void {
  const created = new Set<string>();
  for (const path of paths) {
    let current = parse(path).root;
    for (const segment of relative(current, path).split(sep)) {
      current = join(current, segment);
      if (lstatSync(current, { throwIfNoEntry: false }) === undefined) {
        created.add(current);
        break;
      }
      if (!statSync(current, { throwIfNoEntry: false })?.isDirectory()) break;
    }
  }
  return () => {
    for (const path of created) rmSync(path, { recursive: true, force: true });
  };
}

test.each(invocations)(
  "bun scripts/build.ts with %s writes an executable single-file bundle that runs under node",
  (_name, invocation) => {
    const dir = mkdtempSync(join(tmpdir(), "maxims-build-"));
    try {
      const { cwd, outfileArg, sizeJsonArg, outfile, sizeJson, strays } = invocation(dir);
      const removeStrays = removerOfCreated(strays);
      try {
        const build = runBuild(["--outfile", outfileArg, "--size-json", sizeJsonArg], cwd);
        expect(build.stderr.toString()).toBe("");
        expect(build.exitCode).toBe(0);

        const bytes = statSync(outfile).size;
        expect(build.stdout.toString()).toBe(`bundle: ${outfileArg} ${bytes} bytes\n`);
        expect(JSON.parse(readFileSync(sizeJson, "utf8"))).toEqual({ bytes });

        const text = readFileSync(outfile, "utf8");
        expect(text.startsWith(SHEBANG)).toBe(true);
        expect(text.slice(SHEBANG.length).startsWith("#!")).toBe(false);
        expect(text).not.toContain("node_modules");
        expect(statSync(outfile).mode & 0o777).toBe(0o755);

        const run = Bun.spawnSync(["node", outfile], { stdout: "pipe", stderr: "pipe" });
        expect(run.stderr.toString()).toBe("");
        expect(run.exitCode).toBe(0);
        expect(run.stdout.toString()).toBe(`maxims ${VERSION}\n`);
      } finally {
        removeStrays();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

const usageErrors: [string, (dir: string) => string[], (dir: string) => string[]][] = [
  ["an unknown flag", () => ["--minify"], () => ["unknown argument --minify"]],
  ["a flag without its value", () => ["--outfile"], () => ["--outfile needs a value"]],
  [
    "a flag whose value is the next flag",
    () => ["--outfile", "--size-json", "x"],
    () => ["--outfile needs a value"],
  ],
  [
    "one path for the bundle and the size report",
    (dir) => ["--outfile", join(dir, "cli.js"), "--size-json", join(dir, "cli.js")],
    (dir) => ["--outfile and --size-json both name", join(dir, "cli.js")],
  ],
  [
    "two spellings of one path for the bundle and the size report",
    (dir) => ["--outfile", join(dir, "cli.js"), "--size-json", join("sub", "..", "cli.js")],
    (dir) => ["--outfile and --size-json both name", join(dir, "cli.js")],
  ],
];

test.each(usageErrors)(
  "bun scripts/build.ts with %s exits 2 before writing anything",
  (_name, args, fragments) => {
    const dir = mkdtempSync(join(tmpdir(), "maxims-build-"));
    try {
      const build = runBuild(args(dir), dir);
      expect(build.exitCode).toBe(2);
      expect(build.stdout.toString()).toBe("");
      const stderr = build.stderr.toString();
      for (const fragment of fragments(dir)) expect(stderr).toContain(fragment);
      expect(stderr.endsWith(USAGE)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("an entry that does not parse exits 1 with the bundler's message and writes no bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "maxims-build-"));
  try {
    const entry = join(dir, "broken.ts");
    writeFileSync(entry, "const x = ;\n");
    const outfile = join(dir, "cli.js");
    const build = runBuild(["--entry", "broken.ts", "--outfile", outfile], dir);
    expect(build.exitCode).toBe(1);
    expect(build.stdout.toString()).toBe("");
    const stderr = build.stderr.toString();
    expect(stderr).toContain("Unexpected ;");
    expect(stderr).toContain(`${entry}:1:11`);
    expect(stderr.endsWith("build: bundling failed\n")).toBe(true);
    expect(existsSync(outfile)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
