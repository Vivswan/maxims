// Guards what Cline needs from a file hook and does not check for us: an executable script whose
// first line is a shebang, whose stdout is exactly one JSON object, and which neither reads the
// task metadata on stdin nor lets sync's output through to corrupt that object.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "../../../tests/shared/temp_dir.ts";
import { HOOK_COMMAND, hookSpecFor } from "../contract.ts";
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

test("TaskStart is an executable shebang script that runs sync and answers Cline alone", async () => {
  const script = cline.hook.render(hookSpecFor(cline));
  expect(script.startsWith("#!/usr/bin/env sh\n")).toBe(true);
  expect(cline.hook.executable).toBe(true);

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
});
