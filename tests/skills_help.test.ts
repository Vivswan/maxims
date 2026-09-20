// Fails if terminal noise (ANSI styling, CRLF, trailing spaces, extra final newlines) or the
// caller's environment can reach a capture, or if the committed skills@1.7.0 fixture leaves its
// own normal form: a nightly diff of `skills@latest` against the fixture would then report bytes no
// reader sees as upstream drift.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureSkillsHelp, normalizeHelp } from "../scripts/lib/skills_help.ts";

const ESC = "\x1b";

test("normalizeHelp strips styling, folds CRLF, and trims line ends", () => {
  const raw = `${ESC}[1mUsage:${ESC}[0m skills [options]\r\n\r\n  -g, --global   \r\n  -y, --yes\n\n\n`;
  expect(normalizeHelp(raw)).toBe("Usage: skills [options]\n\n  -g, --global\n  -y, --yes\n");
});

test("the committed skills@1.7.0 fixture is already in normal form", () => {
  const fixture = readFileSync(
    join(import.meta.dir, "fixtures", "golden", "skills-help.txt"),
    "utf8",
  );
  expect(normalizeHelp(fixture)).toBe(fixture);
});

interface Recorded {
  argv: string[];
  env: Record<string, string>;
}

const withEnv = async (
  values: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> => {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("captureSkillsHelp spawns npx with an allowlisted env and normalizes its stdout", async () => {
  const path = process.env.PATH;
  const home = process.env.HOME;
  if (path === undefined || home === undefined) throw new Error("PATH and HOME must be set");
  await withEnv(
    { TMPDIR: "/home/user/tmp", LANG: "C.UTF-8", SKILLS_HELP_STRAY: "leak", NO_COLOR: "0" },
    async () => {
      const calls: Recorded[] = [];
      const page = await captureSkillsHelp("1.7.0", async (argv, env) => {
        calls.push({ argv, env });
        return { exitCode: 0, stdout: `${ESC}[1mUsage:${ESC}[0m skills  \r\n` };
      });
      expect(page).toBe("Usage: skills\n");
      expect(calls).toEqual([
        {
          argv: ["npx", "-y", "skills@1.7.0", "--help"],
          env: {
            PATH: path,
            HOME: home,
            TMPDIR: "/home/user/tmp",
            LANG: "C.UTF-8",
            NO_COLOR: "1",
            CI: "1",
            COLUMNS: "80",
            TERM: "dumb",
            npm_config_registry: "https://registry.npmjs.org/",
          },
        },
      ]);
    },
  );
});

test("captureSkillsHelp rejects a non-zero exit instead of returning its stdout", async () => {
  const failing = () =>
    captureSkillsHelp("1.7.0", async () => ({ exitCode: 1, stdout: "Usage:\n" }));
  await expect(failing()).rejects.toThrow("npx -y skills@1.7.0 --help exited with code 1");
});
