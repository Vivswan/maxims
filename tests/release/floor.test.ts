// Fails if the npm-floor step stops holding the npm trusted publishing needs: an npm at or above 11.5.1 is left
// alone, an older one is upgraded exactly once, and one still below the floor after that upgrade, or whose upgrade
// fails, stops the lane with the error the workflow surfaces. The npm on PATH is a script over a version file, so
// the rows hold without the real npm or the network.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";

const SCRIPT = resolve(import.meta.dir, "..", "..", ".github", "scripts", "release-pipeline.ts");
const UPGRADE = "install -g npm@latest";

/** The npm the step finds: the version it starts at, and the version its upgrade leaves it at or the status the
 * upgrade exits with. */
interface ScriptedNpm {
  bundled: string;
  upgrade: { leaves: string } | { exits: number };
}

/** An npm executable first on PATH, driven by the version file beside it; a call the step never makes exits 64. */
function scriptNpm(dir: string, npm: ScriptedNpm): void {
  writeFileSync(join(dir, "version"), `${npm.bundled}\n`);
  const outcome =
    "exits" in npm.upgrade
      ? `exit ${npm.upgrade.exits}`
      : `printf '%s\\n' '${npm.upgrade.leaves}' > '${join(dir, "version")}'`;
  writeFileSync(
    join(dir, "npm"),
    [
      "#!/bin/sh",
      'case "$1" in',
      `  --version) cat '${join(dir, "version")}' ;;`,
      `  install) echo "$*" >> '${join(dir, "installs")}'; ${outcome} ;;`,
      '  *) echo "unexpected npm $*" >&2; exit 64 ;;',
      "esac",
    ].join("\n"),
  );
  chmodSync(join(dir, "npm"), 0o755);
}

function installs(dir: string): string[] {
  const log = join(dir, "installs");
  return existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
  installs: string[];
}

async function npmFloorStep(npm: ScriptedNpm): Promise<Outcome> {
  return withTempDir((dir) => {
    scriptNpm(dir, npm);
    const run = spawnSync(process.execPath, [SCRIPT, "npm-floor"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (run.error) throw run.error;
    return {
      status: run.status ?? -1,
      stdout: run.stdout,
      stderr: run.stderr,
      installs: installs(dir),
    };
  });
}

const floorError = (version: string): string =>
  `::error::npm ${version} cannot publish through OIDC; trusted publishing needs npm 11.5.1 or newer.\n`;
const silent = { status: 0, stdout: "", stderr: "" };

// The stand-in npm is a POSIX shell script with an exec bit, which Windows cannot run (tests/shared/platform.ts).
describe.skipIf(WINDOWS)("npm-floor", () => {
  const rows: [string, ScriptedNpm, Outcome][] = [
    [
      "an npm at the floor is left alone",
      { bundled: "11.5.1", upgrade: { leaves: "11.9.0" } },
      { ...silent, installs: [] },
    ],
    [
      "an npm above the floor is left alone",
      { bundled: "11.10.0", upgrade: { leaves: "11.10.0" } },
      { ...silent, installs: [] },
    ],
    [
      "an npm below the floor is upgraded once, and the upgrade reaching the floor passes",
      { bundled: "10.9.2", upgrade: { leaves: "11.6.0" } },
      { ...silent, installs: [UPGRADE] },
    ],
    [
      "an upgrade that lands exactly on the floor passes",
      { bundled: "10.9.2", upgrade: { leaves: "11.5.1" } },
      { ...silent, installs: [UPGRADE] },
    ],
    [
      "an upgrade that leaves npm below the floor fails the step with the version it reached",
      { bundled: "10.9.2", upgrade: { leaves: "11.4.2" } },
      { status: 1, stdout: "", stderr: floorError("11.4.2"), installs: [UPGRADE] },
    ],
    [
      "an upgrade that exits non-zero fails the step, naming its exit status",
      { bundled: "10.9.2", upgrade: { exits: 7 } },
      {
        status: 1,
        stdout: "",
        stderr: "release-pipeline npm-floor: npm install -g npm@latest exited 7\n",
        installs: [UPGRADE],
      },
    ],
  ];
  test.each(rows)("%s", async (_row, npm, expected) => {
    expect(await npmFloorStep(npm)).toEqual(expected);
  });
});
