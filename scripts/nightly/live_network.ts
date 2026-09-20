// Drives the built bundle through the fetch ladder against the reference source on the public
// network: the sparse clone, the pinned-sha short circuit, the tarball rung with no git on PATH,
// and a repository that does not exist. Each rung has one expected exit code.
import { accessSync, constants, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { redactUserinfo } from "../../src/sources/github/ladder.ts";
import { markdownTable, type Outcome } from "./report.ts";
import { withScratchDir } from "./scratch.ts";

const REFERENCE_ADD = ["add", "@Vivswan/skills", "-g", "--rule", "-a", "claude-code", "-y"];

export type Step = {
  name: string;
  argv: readonly string[];
  // Which throwaway HOME the step runs in; steps sharing one see each other's state.
  home: "first" | "second";
  git: "on-path" | "off-path";
  expectExit: number;
};

export const LADDER: readonly Step[] = [
  {
    name: "add through a sparse clone",
    argv: REFERENCE_ADD,
    home: "first",
    git: "on-path",
    expectExit: 0,
  },
  {
    name: "config set cooldownDays 0",
    argv: ["config", "set", "cooldownDays", "0"],
    home: "first",
    git: "on-path",
    expectExit: 0,
  },
  {
    name: "update short-circuits on the pinned sha",
    argv: ["update"],
    home: "first",
    git: "on-path",
    expectExit: 0,
  },
  {
    name: "add through the codeload tarball with no git on PATH",
    argv: REFERENCE_ADD,
    home: "second",
    git: "off-path",
    expectExit: 0,
  },
  {
    name: "add a repository that does not exist",
    argv: ["add", "@Vivswan/maxims-nightly-missing-repo"],
    home: "second",
    git: "on-path",
    expectExit: 2,
  },
];

export type CliResult = { exitCode: number; stderr: string };
export type CliRunner = (
  argv: readonly string[],
  env: Record<string, string>,
) => Promise<CliResult>;

export type StepResult = Step & { exitCode: number; stderr: string };

async function spawnNode(argv: readonly string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr };
}

// Every executable on PATH is mirrored into one directory except git, so the bundle finds node
// and everything else it might shell out to, and only git is absent. As in a PATH lookup, the
// first EXECUTABLE of a name wins; a plain file of the same name earlier on PATH is passed over.
export function mirrorPathWithoutGit(path: string, into: string): string {
  const seen = new Set<string>();
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "git" || seen.has(entry) || !isExecutable(join(dir, entry))) continue;
      seen.add(entry);
      symlinkSync(join(dir, entry), join(into, entry));
    }
  }
  return into;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function homeEnv(home: string, path: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    MAXIMS_HOME: join(home, ".agents", "maxims"),
    PATH: path,
    NO_COLOR: "1",
    CI: "1",
  };
}

const show = (argv: readonly string[]): string => `maxims ${argv.join(" ")}`;

export function summarizeLadder(results: readonly StepResult[]): Outcome {
  const failed = results.filter((result) => result.exitCode !== result.expectExit);
  const table = markdownTable(
    ["step", "argv", "expected", "exit", "verdict"],
    results.map((result) => [
      result.name,
      `\`${show(result.argv)}\``,
      String(result.expectExit),
      String(result.exitCode),
      result.exitCode === result.expectExit ? "ok" : "FAIL",
    ]),
  );
  const summary = `## Live network ladder\n\n${table}\n`;
  if (failed.length === 0) return { status: "pass", summary };
  const details = results.map((result) =>
    [
      `### ${result.name}`,
      "",
      `\`${show(result.argv)}\` (git ${result.git}) expected exit ${result.expectExit}, got ${result.exitCode}.`,
      "",
      "```text",
      redactUserinfo(result.stderr).trimEnd(),
      "```",
    ].join("\n"),
  );
  return {
    status: "fail",
    summary,
    report: {
      title: "Live fetch ladder against Vivswan/skills failed",
      body: `${table}\n\n${details.join("\n\n")}\n`,
    },
  };
}

export async function runLiveNetwork(
  bundle: string,
  run: CliRunner = spawnNode,
  ladder: readonly Step[] = LADDER,
): Promise<Outcome> {
  const node = Bun.which("node");
  if (node === null) throw new Error("no node on PATH to run the bundle with");
  if (!existsSync(bundle)) throw new Error(`${bundle} is missing; run \`bun run build\` first`);
  return withScratchDir("maxims-live-network-", async (scratch) => {
    const homes = { first: join(scratch, "home-first"), second: join(scratch, "home-second") };
    const withoutGit = join(scratch, "bin-without-git");
    for (const dir of [...Object.values(homes), withoutGit]) mkdirSync(dir);
    const fullPath = process.env.PATH ?? "";
    let mirrored: string | null = null;
    const pathFor = (git: Step["git"]): string => {
      if (git === "on-path") return fullPath;
      mirrored ??= mirrorPathWithoutGit(fullPath, withoutGit);
      return mirrored;
    };
    const results: StepResult[] = [];
    for (const step of ladder) {
      const result = await run(
        [node, bundle, ...step.argv],
        homeEnv(homes[step.home], pathFor(step.git)),
      );
      results.push({ ...step, ...result });
    }
    return summarizeLadder(results);
  });
}
