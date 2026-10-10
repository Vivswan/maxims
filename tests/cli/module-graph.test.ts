// Fails if the hook path regrows: a static import chain from the bin entry, the engine loader or
// the sync verb that reaches the interactive frame, the color library, agent detection, the
// GitHub fetch ladder, the git and tarball resolvers or the diff renderer would load them at
// every session start, which the latency budget forbids.
//
// The static walk skips dynamic imports (how the interactive verbs and the resolvers are meant to
// load) and type-only imports (erased by the compiler). What a dynamic import does load, the probe
// test pins: it runs the real `sync --quiet` in an empty home and lists every module bun evaluated.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { resolveImport, SOURCE_EXTENSIONS } from "../../scripts/arch_lint.mts";
import { childEnv, makeHome } from "../e2e/binary.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const SRC = resolve(import.meta.dir, "..", "..", "src");
const CLI = join(SRC, "cli.ts");
const scanner = new Bun.Transpiler({ loader: "ts" });

const HEAVY = [
  "@clack/prompts",
  "picocolors",
  "@vercel/detect-agent",
  "simple-git",
  "tar",
  "debug",
  "diff",
];

const HOOK_PATH_EXCLUDES = [
  "sources/github/ladder.ts",
  "sources/github/index.ts",
  "sources/github/tarball.ts",
  "sources/git/index.ts",
  "console/clack.ts",
  "console/rename.ts",
  "commands/add.ts",
  "commands/update.ts",
].map((path) => resolve(SRC, path));

const HOOK_PATH_ROOTS = [
  "cli.ts",
  "commands/loader.ts",
  "commands/engine-verbs.ts",
  "commands/sync.ts",
].map((path) => resolve(SRC, path));

/**
 * The specifiers a module loads when imported: its import and re-export statements after the
 * bundler's own type erasure. A non-source path (package.json) is a data leaf and imports
 * nothing; a source file that does not parse throws rather than reading as import-free.
 */
function staticImports(file: string): string[] {
  if (!SOURCE_EXTENSIONS.includes(extname(file))) return [];
  const text = readFileSync(file, "utf8").replace(/^#!.*\n/, "");
  return scanner
    .scanImports(text)
    .filter((entry) => entry.kind === "import-statement")
    .map((entry) => entry.path);
}

function walk(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith(".")) queue.push(resolveImport(file, specifier));
      else seen.add(specifier);
    }
  }
  return seen;
}

// Sorted, so a row below names a set and a reordering of the lists above changes nothing.
function offenders(graph: Set<string>): { packages: string[]; modules: string[] } {
  return {
    packages: HEAVY.filter((name) => graph.has(name)).sort(),
    modules: HOOK_PATH_EXCLUDES.filter((path) => graph.has(path))
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .sort(),
  };
}

test("the static graph from the bin entry, the engine loader and the sync verb carries no fetch or interactive module", () => {
  const graph = new Set(HOOK_PATH_ROOTS.flatMap((root) => [...walk(root)]));
  expect(offenders(graph)).toEqual({ packages: [], modules: [] });
});

// The negative controls: the same check over graphs known to carry the interactive libraries and
// the fetch ladder must name them, or a green run above proves nothing.
const CONTROLS: [string, string, ReturnType<typeof offenders>][] = [
  [
    "the clack renderer",
    "console/clack.ts",
    { packages: ["@clack/prompts", "picocolors"], modules: ["console/clack.ts"] },
  ],
  [
    "the github resolver",
    "sources/github/index.ts",
    {
      packages: ["debug", "simple-git", "tar"],
      modules: ["sources/github/index.ts", "sources/github/ladder.ts", "sources/github/tarball.ts"],
    },
  ],
  [
    // The show verb renders a diff and never fetches, so the walk carries the diff library alone.
    "the show verb",
    "commands/show.ts",
    { packages: ["diff"], modules: [] },
  ],
];

test.each(CONTROLS)("the check names what a walk from %s carries", (_name, root, expected) => {
  expect(offenders(walk(resolve(SRC, root)))).toEqual(expected);
});

// Every module the run evaluated, written when the process exits as the raw require.cache paths;
// evaluatedModules folds dependency paths to package names, the vocabulary `offenders` reads.
const PROBE = `
process.on("exit", () => {
  require("node:fs").writeFileSync(process.env.MAXIMS_PROBE_OUT, Object.keys(require.cache).join("\\n"));
});
`;

function packageNameOf(path: string): string | null {
  const marker = `${sep}node_modules${sep}`;
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const [scope, name] = path.slice(at + marker.length).split(sep);
  return scope?.startsWith("@") ? `${scope}/${name}` : (scope ?? null);
}

type Evaluated = { modules: Set<string>; code: number | null; stderr: string };

async function evaluatedModules(argv: string[], dir: string): Promise<Evaluated> {
  const home = makeHome(dir);
  const probe = join(dir, "probe.cjs");
  const out = join(dir, "modules.txt");
  writeFileSync(probe, PROBE);
  const proc = Bun.spawnSync(["bun", "--preload", probe, CLI, ...argv], {
    cwd: home.root,
    env: childEnv(home, { MAXIMS_PROBE_OUT: out }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const modules = new Set<string>();
  for (const path of readFileSync(out, "utf8").split("\n")) {
    modules.add(packageNameOf(path) ?? path);
  }
  return { modules, code: proc.exitCode, stderr: proc.stderr.toString() };
}

test("a session-start sync --quiet in an empty home evaluates no fetch or interactive module", async () => {
  await withTempDir(async (dir) => {
    const run = await evaluatedModules(["sync", "--quiet"], dir);
    expect({ ...run, modules: offenders(run.modules) }).toEqual({
      modules: { packages: [], modules: [] },
      code: 0,
      stderr: "",
    });
  });
});

// The negative control: an `add` that reaches for a git remote must evaluate both remote
// resolvers and their ladder, or a green run above proves only that the probe is blind. The
// remote is a closed local port, so the fetch fails at once and nothing leaves the machine.
test("the probe names what an add fetching a git remote evaluates", async () => {
  await withTempDir(async (dir) => {
    const url = "http://127.0.0.1:1/rules.git";
    const run = await evaluatedModules(["add", url, "-g", "--rule", "-a", "codex", "-y"], dir);
    expect(run.stderr).toContain(`cannot fetch ${url}`);
    expect({ code: run.code, ...offenders(run.modules) }).toEqual({
      code: 2,
      packages: ["debug", "simple-git", "tar"],
      modules: [
        "commands/add.ts",
        "console/rename.ts",
        "sources/git/index.ts",
        "sources/github/index.ts",
        "sources/github/ladder.ts",
        "sources/github/tarball.ts",
      ],
    });
  });
});
