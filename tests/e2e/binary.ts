// The bundle a user installs, driven under node in a home of its own. Every e2e file builds its
// bundle into a temp directory once, since `dist/cli.js` may be stale or absent while the tests
// run, and spawns it with an allowlisted environment: the inherited one carries this session's
// agent markers and harness overrides, which would change what the binary detects.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const buildScript = join(repoRoot, "scripts", "build.ts");

export type Bundle = { path: string; bytes: number };

// The published `dist/cli.js` runs under the package's `"type": "module"`; the temp copy gets the
// same declaration beside it, or a node before 20.19 reads the ESM bundle as CommonJS.
export function buildBundle(dir: string): Bundle {
  const path = join(dir, "cli.js");
  const sizeJson = join(dir, "size.json");
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  const build = Bun.spawnSync(["bun", buildScript, "--outfile", path, "--size-json", sizeJson], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`bundle build exited ${build.exitCode}:\n${build.stderr.toString()}`);
  }
  const { bytes } = JSON.parse(readFileSync(sizeJson, "utf8")) as { bytes: number };
  return { path, bytes };
}

// `root` is the user's home, `maximsHome` the maxims store inside it, `project` a git checkout
// beside it for the project-scoped verbs.
export type Home = { root: string; maximsHome: string; project: string };

export function makeHome(dir: string): Home {
  const root = join(dir, "home");
  const maximsHome = join(root, ".agents", "maxims");
  const project = join(dir, "project");
  mkdirSync(maximsHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q", project], { stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(`git init failed:\n${init.stderr.toString()}`);
  return { root, maximsHome, project };
}

// `stdin: "open"` is a pipe that never reaches EOF, the shape a harness may hand its hook; a
// string is written whole and closed; absent means nothing to read at all.
export type RunOptions = {
  cwd?: string;
  stdin?: string | "open";
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type Run = { code: number; stdout: string; stderr: string };

const DEFAULT_TIMEOUT_MS = 30_000;

const INHERITED = ["PATH", "TMPDIR", "LANG"];
const INHERITED_WIN32 = ["SystemRoot", "TEMP", "TMP", "COMSPEC", "PATHEXT"];

export function childEnv(home: Home, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const names = process.platform === "win32" ? [...INHERITED, ...INHERITED_WIN32] : INHERITED;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (names.includes(key) || key.startsWith("GIT_"))) env[key] = value;
  }
  return {
    ...env,
    HOME: home.root,
    USERPROFILE: home.root,
    XDG_CONFIG_HOME: join(home.root, ".config"),
    MAXIMS_HOME: home.maximsHome,
    NO_COLOR: "1",
    COLUMNS: "80",
    TERM: "dumb",
    ...extra,
  };
}

export async function runMaxims(
  bundle: Bundle,
  home: Home,
  argv: string[],
  options: RunOptions = {},
): Promise<Run> {
  const proc = Bun.spawn(["node", bundle.path, ...argv], {
    cwd: options.cwd ?? home.root,
    env: childEnv(home, options.env),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin;
  if (typeof options.stdin === "string" && options.stdin !== "open") {
    if (sink === undefined) throw new Error("the stdin pipe was not opened");
    sink.write(options.stdin);
    await sink.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new Error(
        `maxims ${argv.join(" ")} was killed after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`,
      );
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (options.stdin === "open") sink?.end();
  }
}
