// What would drift silently: the bin entry resolving the home before `main` runs, where a refusal
// escapes the one place that turns a failure under `--quiet` into exit 0, so a session-start hook
// on a machine with no home (a blank HOME and no record of the user) breaks every session.
//
// A test cannot take the record of its own user away, as a container user with no passwd entry
// has none, so the entry runs in a fresh process whose `os.userInfo` throws. The probe proves the
// home is refused before it loads the entry: a probe that failed to take the record away exits 99
// without running anything. The probe blanks the environment itself, so the runtime under it still
// starts in the launcher's temp HOME.
import { expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../../src/util/exit-codes.ts";
import { srcPath } from "../shared/src_path.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const PROBE = `
import os from "node:os";
process.env.HOME = "";
process.env.USERPROFILE = " ";
delete process.env.MAXIMS_HOME;
os.userInfo = () => {
  throw new Error("no record of the user");
};
const { maximsHome } = await import(${JSON.stringify(srcPath("util", "home.ts"))});
try {
  maximsHome(process.env);
  process.exit(99);
} catch {}
await import(${JSON.stringify(srcPath("cli.ts"))});
`;

type Run = { exitCode: number | null; stdout: string; stderr: string; written: string[] };

function runWithoutHome(args: string[]): Promise<Run> {
  return withTempDir((dir) => {
    const probe = join(dir, "probe.mts");
    writeFileSync(probe, PROBE);
    const proc = Bun.spawnSync(["bun", probe, ...args], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      written: readdirSync(dir).filter((name) => name !== "probe.mts"),
    };
  });
}

test("sync --quiet on a machine with no home exits 0, silent, with nothing written", async () => {
  expect(await runWithoutHome(["sync", "--quiet"])).toEqual({
    exitCode: ExitCode.Ok,
    stdout: "",
    stderr: "",
    written: [],
  });
});

test("sync on a machine with no home is refused with the message and the hint", async () => {
  expect(await runWithoutHome(["sync"])).toEqual({
    exitCode: ExitCode.Usage,
    stdout: "",
    stderr: " ERROR  cannot find the user's home folder\nTip: set HOME to an absolute path\n",
    written: [],
  });
});
