// Fails if a run reaches the network or a caller-supplied HOME, if the repository mount becomes
// writable, if the Dockerfile's home drifts from the HOME the runner injects, if the hermetic
// probe reads its own failures as success, or if the tier's entry stops exiting 0 on a machine
// without a runtime.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArgv,
  CONTAINER_HOME,
  detectRuntime,
  HERMETIC_PROBE_OK,
  hermeticProbe,
  type ProbePaths,
  REPO_ROOT,
  RUNTIMES,
  runArgv,
  skipNotice,
} from "./runner.ts";

const HOST_REPO = "/home/user/repo";

describe("runtime selection from injected probe results", () => {
  const cases: [readonly boolean[], number | null][] = [
    [[true, true], 0],
    [[false, true], 1],
    [[true, false], 0],
    [[false, false], null],
  ];
  test.each(cases)("available %j selects index %p", (available, index) => {
    const selected = detectRuntime((runtime) => available[RUNTIMES.indexOf(runtime)] === true);
    expect(selected).toBe(index === null ? null : RUNTIMES[index]);
  });
});

describe.each([...RUNTIMES])("%s argv", (runtime) => {
  test("run disables the network and pins HOME after the caller's env", () => {
    const argv = runArgv(
      runtime,
      {
        image: "example:tag",
        cmd: ["sh", "-c", "true"],
        env: { NO_COLOR: "1", HOME: "/elsewhere" },
      },
      HOST_REPO,
    );
    expect(argv).toEqual([
      runtime,
      "run",
      "--rm",
      "--security-opt",
      "label=disable",
      "--network",
      "none",
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
  });

  test("live network drops only the network flag", () => {
    const sealed = runArgv(runtime, { image: "example:tag", cmd: ["true"] }, HOST_REPO);
    const live = runArgv(
      runtime,
      { image: "example:tag", cmd: ["true"], network: "live" },
      HOST_REPO,
    );
    expect(live).toEqual(sealed.filter((arg) => arg !== "--network" && arg !== "none"));
  });

  test("build names the Dockerfile inside the context", () => {
    expect(buildArgv(runtime, "example:tag", "/tmp/context")).toEqual([
      runtime,
      "build",
      "--tag",
      "example:tag",
      "--file",
      "/tmp/context/Dockerfile",
      "/tmp/context",
    ]);
  });
});

test("the Dockerfile's user home is the HOME the runner injects", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "tests", "container", "Dockerfile"), "utf8");
  expect(dockerfile).toContain(`--home-dir ${CONTAINER_HOME} `);
  expect(dockerfile).toContain(`\nENV HOME=${CONTAINER_HOME}\n`);
});

describe("hermetic probe", () => {
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

  function probe({ arrange, stdout }: Scene): void {
    const root = mkdtempSync(join(tmpdir(), "maxims-probe-"));
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
      rmSync(root, { recursive: true, force: true });
    }
  }

  test.each(scenes)("$name", probe);
  test.skipIf(process.getuid?.() === 0)(unlistable.name, () => probe(unlistable));
});

test("the tier's entry prints the skip notice and exits 0 without a runtime", () => {
  const emptyPath = mkdtempSync(join(tmpdir(), "maxims-empty-path-"));
  try {
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
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
});
