// Guards what Cline needs from a file hook and does not check for us: an executable script whose
// first line is a shebang, whose stdout is exactly one JSON object, and which neither reads the
// task metadata on stdin nor lets sync's output through to corrupt that object. Also pins where
// Cline reads the rule files and the script per scope, and that only its directories, not a stray
// file, count as an install.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "../../../tests/shared/platform.ts";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { assertInsideRoot } from "../../util/fs.ts";
import { type HarnessContext, HOOK_COMMAND, hookSpecFor, type Scope } from "../contract.ts";
import { hasHook, planFileHookWrite } from "../hook-writer.ts";
import { planRulesDirWrite } from "../strategies/rules-dir.ts";
import { cline } from "./index.ts";

const FAKE_NPX = [
  "#!/usr/bin/env sh",
  'printf "%s" "$*" > "$MAXIMS_FAKE_ARGS"',
  'wc -c < /dev/stdin > "$MAXIMS_FAKE_STDIN_BYTES"',
  'echo "stray output that must never reach Cline"',
  'echo "stray error" >&2',
  "exit 0",
  "",
].join("\n");

// The hook is a POSIX sh script executed through its shebang; Windows cannot run it.
test.skipIf(WINDOWS)(
  "TaskStart is an executable shebang script that runs sync and answers Cline alone",
  async () => {
    if (!hasHook(cline, "file")) throw new Error("Cline runs an executable hook script");
    const hook = cline.hook;
    const script = hook.render(hookSpecFor(cline));
    expect(script.startsWith("#!/usr/bin/env sh\n")).toBe(true);
    expect(hook.executable).toBe(true);

    await withTempDir(async (dir) => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "npx"), FAKE_NPX);
      chmodSync(join(bin, "npx"), 0o755);
      const hookPath = join(dir, "TaskStart");
      writeFileSync(hookPath, script);
      chmodSync(hookPath, 0o755);
      const argsFile = join(dir, "args");
      const stdinFile = join(dir, "stdin-bytes");

      const proc = Bun.spawn([hookPath], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          MAXIMS_FAKE_ARGS: argsFile,
          MAXIMS_FAKE_STDIN_BYTES: stdinFile,
        },
        stdin: new Blob([readFileSync(join(import.meta.dir, "fixtures", "hook-stdin.json"))]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect({ stdout, stderr, exitCode }).toEqual({
        stdout: '{"cancel": false}\n',
        stderr: "",
        exitCode: 0,
      });
      expect(`npx ${readFileSync(argsFile, "utf8")}`).toBe(HOOK_COMMAND);
      expect(readFileSync(stdinFile, "utf8").trim()).toBe("0");
    });
  },
);

const ctx: HarnessContext = { home: "/home/user", projectRoot: "/home/user/project", env: {} };
const block =
  "<!-- maxims:begin @example-user/doctrine sha=1 -->\n<!-- maxims:end @example-user/doctrine -->\n";

const files: [Scope, string, string, string][] = [
  [
    "project",
    "/home/user/project",
    "/home/user/project/.clinerules/maxims-example-user-doctrine.md",
    "/home/user/project/.clinerules/hooks/TaskStart",
  ],
  [
    "global",
    "/home/user",
    "/home/user/Documents/Cline/Rules/maxims-example-user-doctrine.md",
    "/home/user/Documents/Cline/Hooks/TaskStart",
  ],
];

// A Cline rule file is the block and nothing more: frontmatter would be injected as rule text.
test.each(files)(
  "the %s rule file and TaskStart script land where Cline reads them",
  (scope, root, rulePath, hookPath) => {
    const target = cline.targets[scope];
    if (target?.kind !== "rules-dir") throw new Error("Cline reads a rules directory");
    expect(
      planRulesDirWrite({
        def: cline,
        target,
        scope,
        ctx,
        sourceSlug: "example-user-doctrine",
        block,
      }),
    ).toEqual([{ kind: "write", path: assertInsideRoot(root, rulePath), content: block }]);
    if (!hasHook(cline, "file")) throw new Error("Cline runs an executable hook script");
    const [written] = planFileHookWrite({
      def: cline,
      scope,
      ctx,
      wanted: true,
      current: null,
    }).changes;
    expect(written).toEqual({
      kind: "write",
      path: assertInsideRoot(root, hookPath),
      content: [
        "#!/usr/bin/env sh",
        "# Written by maxims. Remove it with `maxims remove` or delete this file; edits are overwritten.",
        "npx -y @vivswan/maxims sync --quiet </dev/null >/dev/null 2>&1",
        `printf '%s\\n' '{"cancel": false}'`,
        "",
      ].join("\n"),
      mode: 0o755,
    });
  },
);

const installs: [string, string | null, "dir" | "file", boolean][] = [
  ["nothing under the home", null, "dir", false],
  ["a Documents directory alone", "Documents", "dir", false],
  ["Documents/Cline", "Documents/Cline", "dir", true],
  ["a .cline directory", ".cline", "dir", true],
  ["a stray file named .cline", ".cline", "file", false],
];

test.each(installs)("detection with %s reads %p", async (_, entry, kind, expected) => {
  await withTempDir((home) => {
    if (entry !== null && kind === "dir") mkdirSync(join(home, entry), { recursive: true });
    if (entry !== null && kind === "file") writeFileSync(join(home, entry), "");
    expect(cline.detect({ home, projectRoot: null, env: {} })).toBe(expected);
  });
});
