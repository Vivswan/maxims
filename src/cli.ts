#!/usr/bin/env node
// The bin entry: real streams, the real machine, the engine as built. Everything else is `main`,
// which the tests drive with injected fakes.

import { createEngine } from "./commands/loader.ts";
import { main } from "./commands/main.ts";
import { detectAgent } from "./console/mode.ts";
import { findProjectRoot } from "./engine/context.ts";
import { maximsHome, userHome } from "./util/home.ts";

const stdout = process.stdout;
process.exitCode = await main(process.argv.slice(2), {
  loadEngine: (options) => createEngine({ ...options, env: process.env }),
  io: {
    env: process.env,
    cwd: process.cwd(),
    // Both homes resolve when `main` reads them: a machine with neither is then a failure like
    // any other there, which `--quiet` turns into exit 0.
    get home() {
      return maximsHome(process.env);
    },
    get userHome() {
      return userHome(process.env);
    },
    projectRoot: findProjectRoot(process.cwd()),
    now: () => new Date(),
    stdin: process.stdin,
    stdout,
    stderr: process.stderr,
  },
  stdoutTty: { isTTY: stdout.isTTY === true, columns: stdout.columns },
  stdinTty: process.stdin.isTTY === true,
  interactive: stdout.isTTY === true ? { output: stdout, input: process.stdin } : null,
  detectAgent,
});
