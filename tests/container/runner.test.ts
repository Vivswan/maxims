// Fails if a run reaches the network or a caller-supplied HOME, if the repository mount becomes
// writable, if the Dockerfile's home drifts from the HOME the runner injects, if the hermetic
// probe reads its own failures as success, or if the tier's entry stops exiting 0 on a machine
// without a runtime.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "../shared/platform.ts";
import { withTempDir } from "../shared/temp_dir.ts";
import {
  CONTAINER_HOME,
  HERMETIC_PROBE_OK,
  hermeticProbe,
  type ProbePaths,
  REPO_ROOT,
  RUNTIMES,
  type RunOptions,
  runArgv,
  skipNotice,
} from "./runner.ts";

const HOST_REPO = "/home/user/repo";

const networks: [string, RunOptions["network"] | undefined, string[]][] = [
  ["unset, sealed by default", undefined, ["--network", "none"]],
  ["none", "none", ["--network", "none"]],
  ["live", "live", []],
];

describe.each([...RUNTIMES])("%s run argv", (runtime) => {
  test.each(networks)(
    "with the network %s: the flag alone moves, HOME lands after the caller's env, the checkout mounts read-only",
    (_case, network, flags) => {
      const argv = runArgv(
        runtime,
        {
          image: "example:tag",
          cmd: ["sh", "-c", "true"],
          env: { NO_COLOR: "1", HOME: "/elsewhere" },
          ...(network === undefined ? {} : { network }),
        },
        HOST_REPO,
      );
      expect(argv).toEqual([
        runtime,
        "run",
        "--rm",
        "--security-opt",
        "label=disable",
        ...flags,
        "-e",
        "NO_COLOR=1",
        "-e",
        "HOME=/elsewhere",
        "-e",
        "HOME=/home/tester",
        "--volume",
        "/home/user/repo:/repo:ro",
        "example:tag",
        "sh",
        "-c",
        "true",
      ]);
    },
  );
});

test("the Dockerfile's user home is the HOME the runner injects", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "tests", "container", "Dockerfile"), "utf8");
  expect(dockerfile).toContain(`--home-dir ${CONTAINER_HOME} `);
  expect(dockerfile).toContain(`\nENV HOME=${CONTAINER_HOME}\n`);
});

// The probe is a POSIX sh script run on the host; Windows has no sh that takes these paths.
describe.skipIf(WINDOWS)("hermetic probe", () => {
  type Scene = { name: string; arrange: (paths: ProbePaths) => ProbePaths; stdout: string };
  const passing = (paths: ProbePaths) => paths;
  // Root lists a 0300 directory through CAP_DAC_OVERRIDE, so that scene only proves anything
  // for an unprivileged suite.
  const unlistable: Scene = {
    name: "HOME cannot be listed",
    arrange: (paths) => {
      chmodSync(paths.home, 0o300);
      return paths;
    },
    stdout: "home-is-expected\n",
  };
  const scenes: Scene[] = [
    { name: "an empty writable HOME, a copied repo, and only lo", arrange: passing, stdout: "" },
    {
      name: "HOME differs from the expected path",
      arrange: (paths) => ({ ...paths, home: join(paths.home, "other") }),
      stdout: "",
    },
    {
      name: "HOME holds a file",
      arrange: (paths) => {
        writeFileSync(join(paths.home, ".claude.json"), "{}\n");
        return paths;
      },
      stdout: "home-is-expected\n",
    },
    {
      name: "the repository copy is missing",
      arrange: (paths) => {
        rmSync(join(paths.work, "package.json"));
        return paths;
      },
      stdout: "home-is-expected\nhome-empty\n",
    },
    {
      name: "a second interface exists",
      arrange: (paths) => {
        writeFileSync(join(paths.networkDir, "eth0"), "");
        return paths;
      },
      stdout: "home-is-expected\nhome-empty\nwork-copied\nhome-writable\n",
    },
  ];

  function probe({ arrange, stdout }: Scene): Promise<void> {
    return withTempDir((root) => {
      const paths = {
        home: join(root, "home"),
        work: join(root, "work"),
        networkDir: join(root, "net"),
      };
      try {
        for (const dir of Object.values(paths)) mkdirSync(dir);
        writeFileSync(join(paths.work, "package.json"), "{}\n");
        writeFileSync(join(paths.networkDir, "lo"), "");
        const expected = arrange(paths);
        const proc = Bun.spawnSync(hermeticProbe(expected), {
          env: { PATH: process.env.PATH ?? "", HOME: paths.home },
          stdout: "pipe",
          stderr: "pipe",
        });
        const passes = arrange === passing;
        expect({ passes: proc.exitCode === 0, stdout: proc.stdout.toString() }).toEqual({
          passes,
          stdout: passes ? HERMETIC_PROBE_OK : stdout,
        });
      } finally {
        chmodSync(paths.home, 0o700);
      }
    });
  }

  test.each(scenes)("$name", probe);
  test.skipIf(process.getuid?.() === 0)(unlistable.name, () => probe(unlistable));
});

test("the tier's entry prints the skip notice and exits 0 without a runtime", async () => {
  await withTempDir((emptyPath) => {
    const proc = Bun.spawnSync([process.execPath, "scripts/container_tests.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: emptyPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: proc.exitCode, stdout: proc.stdout.toString() }).toEqual({
      exitCode: 0,
      stdout: `${skipNotice()}\n`,
    });
  });
});
