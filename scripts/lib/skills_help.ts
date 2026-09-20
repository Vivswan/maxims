import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `skills` prints bold through NO_COLOR, so the normalizer strips ANSI regardless; the rest keeps
// the page width and the terminal kind fixed so a capture on any machine wraps identically. The
// registry is pinned because a mirror configured in npmrc can lag behind the public one and answer
// a fresh version with "no matching version found".
export const SKILLS_HELP_ENV = {
  NO_COLOR: "1",
  CI: "1",
  COLUMNS: "80",
  TERM: "dumb",
  npm_config_registry: "https://registry.npmjs.org/",
} as const;

export const SKILLS_HELP_ARGV = (spec: string): string[] => [
  "npx",
  "-y",
  `skills@${spec}`,
  "--help",
];

const INHERITED_ENV = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

export type HelpRunner = (
  argv: string[],
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string }>;

export function normalizeHelp(raw: string): string {
  const lines = Bun.stripANSI(raw)
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

function captureEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...SKILLS_HELP_ENV };
}

// The child runs from an empty scratch directory with its own npm cache, so neither a package.json
// above the caller's cwd nor a previously cached `skills` can change which page is printed.
const runNpx: HelpRunner = async (argv, env) => {
  const scratch = mkdtempSync(join(tmpdir(), "skills-help-"));
  try {
    const proc = Bun.spawn(argv, {
      cwd: scratch,
      env: { ...env, npm_config_cache: join(scratch, "npm-cache") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: await proc.exited, stdout };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export async function captureSkillsHelp(spec: string, run: HelpRunner = runNpx): Promise<string> {
  const argv = SKILLS_HELP_ARGV(spec);
  const { exitCode, stdout } = await run(argv, captureEnv());
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} exited with code ${exitCode}`);
  return normalizeHelp(stdout);
}
