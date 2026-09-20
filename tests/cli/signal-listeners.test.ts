// Fails if the command line ever registers its own SIGINT, SIGTERM or SIGHUP listener: the lock's
// exit hook releases held locks through signal-exit, which yields to any other listener the
// process installs, so a listener that does not end in process.exit would leave a lock behind on
// an interrupted sync. Clack's own spinner installs such listeners while it runs, which is why the
// clack console draws its own. The probe runs in a fresh process, since this test process has
// already imported the same modules, and the control injects a listener to prove the probe sees one.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withTempDir } from "../shared/temp_dir.ts";

const SRC = resolve(import.meta.dir, "..", "..", "src");

const PROBE = `
import { PassThrough } from "node:stream";
await import(${JSON.stringify(join(SRC, "util", "lock.ts"))});
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const counts = () => Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
const baseline = counts();
for (const file of [
  "commands/main.ts", "console/contract.ts", "console/mode.ts", "commands/add.ts",
  "commands/update.ts", "commands/install.ts", "commands/init.ts", "commands/config.ts",
  "commands/lint.ts", "commands/doctor.ts", "commands/link.ts", "commands/disable.ts",
  "commands/engine-verbs.ts", "commands/mcp-serve.ts", "commands/engine.ts",
]) {
  await import(${JSON.stringify(SRC)} + "/" + file);
}
const { createClackConsole } = await import(${JSON.stringify(join(SRC, "console", "clack.ts"))});
const output = new PassThrough();
output.resume();
const console_ = createClackConsole(
  { tty: true, stdinTty: false, agent: null, yes: true, quiet: false, json: false, width: 80 },
  { output, input: new PassThrough() },
);
const spinner = console_.spinner("Cloning repository...");
const during = counts();
spinner.stop("Repository cloned");
if (process.argv.includes("--inject")) process.on("SIGTERM", () => undefined);
process.stdout.write(JSON.stringify({ baseline, during, after: counts() }));
`;

type Counts = Record<string, number>;
type Report = { baseline: Counts; during: Counts; after: Counts };

async function probe(inject: boolean): Promise<Report> {
  return withTempDir(async (dir) => {
    const file = join(dir, "probe.mts");
    writeFileSync(file, PROBE);
    const proc = Bun.spawnSync(["bun", file, ...(inject ? ["--inject"] : [])], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    return JSON.parse(proc.stdout.toString()) as Report;
  });
}

test("loading every command-line module and running a spinner adds no signal listener", async () => {
  const report = await probe(false);
  expect(report.during).toEqual(report.baseline);
  expect(report.after).toEqual(report.baseline);
});

test("the probe sees a listener that is added", async () => {
  const report = await probe(true);
  expect(report.after.SIGTERM).toBe((report.baseline.SIGTERM ?? 0) + 1);
});
