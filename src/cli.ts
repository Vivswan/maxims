#!/usr/bin/env node
import { homedir } from "node:os";
import { loadEngine } from "./commands/engine.ts";
import { main } from "./commands/main.ts";
import { findProjectRoot } from "./commands/shared/cli-context.ts";
import { detectAgent } from "./console/mode.ts";
import { maximsHome } from "./util/home.ts";

// The bin entry: real streams, the real machine, the engine as built. Everything else is `main`,
// which the tests drive with injected fakes.
const stdout = process.stdout;
process.exitCode = await main(process.argv.slice(2), {
  loadEngine,
  io: {
    env: process.env,
    cwd: process.cwd(),
    home: maximsHome(process.env),
    userHome: process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
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
