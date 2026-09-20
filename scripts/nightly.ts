// Nightly entry point. W4a replaces this placeholder with the per-category runs (parity drift,
// harness drift, live network, latency trend, deep property runs); until then the nightly is a
// green run of the ordinary suite so an uncustomized starter files no issues.
const proc = Bun.spawnSync(["bun", "run", "test"], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(proc.exitCode ?? 1);
