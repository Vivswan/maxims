// Nightly entry point. Until the per-category nightly runs exist (parity drift, harness drift,
// live network, latency trend, deep property runs), this is a green run of the ordinary suite so
// an uncustomized starter files no issues.
const proc = Bun.spawnSync(["bun", "run", "test"], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(proc.exitCode ?? 1);
