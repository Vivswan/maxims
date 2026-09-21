import { createConsole, type InteractiveStreams } from "../console/contract.ts";
import { consoleMode } from "../console/mode.ts";
import { STRINGS, unknownCommand } from "../console/strings.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { appendRefreshLog } from "../util/log.ts";
import { VERSION } from "../version.ts";
import { readConfig } from "./shared/cli-context.ts";
import { ReportedMaximsError } from "./shared/errors.ts";
import {
  type Args,
  type Command,
  type CommandContext,
  FLAGS,
  type FlagSpec,
  GLOBAL_FLAGS,
  globalFlags,
  parseVerbArgs,
  usage,
} from "./shared/options.ts";
import type { EngineBundle, MachineIo } from "./types.ts";

// The engine is a loader, called only once a verb is about to run: `--help`, `--version` and a
// usage error never pay for it. It learns whether the run is quiet, so a hook run's resolver
// warnings stay off stderr.
export type CliDeps = {
  loadEngine: (options: { quiet: boolean }) => Promise<EngineBundle>;
  io: MachineIo;
  stdoutTty: { isTTY: boolean; columns?: number };
  stdinTty: boolean;
  interactive: InteractiveStreams | null;
  detectAgent: () => Promise<string | null>;
};

type VerbEntry = {
  name: string;
  aliases: readonly string[];
  hidden: boolean;
  load: () => Promise<Command>;
};

// Every verb is a dynamic import so `sync --quiet` loads its own module and nothing else: the
// interactive verbs pull in the console renderers and the fetch code only when they run.
const VERBS: readonly VerbEntry[] = [
  { name: "add", aliases: ["a"], hidden: false, load: () => import("./add.ts").then((m) => m.add) },
  {
    name: "sync",
    aliases: [],
    hidden: false,
    load: () => import("./engine-verbs.ts").then((m) => m.sync),
  },
  {
    name: "update",
    aliases: ["check", "upgrade"],
    hidden: false,
    load: () => import("./update.ts").then((m) => m.update),
  },
  {
    name: "remove",
    aliases: ["rm", "r"],
    hidden: false,
    load: () => import("./engine-verbs.ts").then((m) => m.remove),
  },
  {
    name: "list",
    aliases: ["ls"],
    hidden: false,
    load: () => import("./engine-verbs.ts").then((m) => m.list),
  },
  {
    name: "install",
    aliases: ["i"],
    hidden: false,
    load: () => import("./install.ts").then((m) => m.install),
  },
  {
    name: "share",
    aliases: [],
    hidden: false,
    load: () => import("./share.ts").then((m) => m.share),
  },
  {
    name: "unshare",
    aliases: [],
    hidden: false,
    load: () => import("./share.ts").then((m) => m.unshare),
  },
  { name: "link", aliases: [], hidden: false, load: () => import("./link.ts").then((m) => m.link) },
  {
    name: "unlink",
    aliases: [],
    hidden: false,
    load: () => import("./link.ts").then((m) => m.unlink),
  },
  {
    name: "disable",
    aliases: [],
    hidden: false,
    load: () => import("./disable.ts").then((m) => m.disable),
  },
  {
    name: "enable",
    aliases: [],
    hidden: false,
    load: () => import("./disable.ts").then((m) => m.enable),
  },
  {
    name: "review",
    aliases: [],
    hidden: false,
    load: () => import("./review.ts").then((m) => m.review),
  },
  {
    name: "unreview",
    aliases: [],
    hidden: false,
    load: () => import("./review.ts").then((m) => m.unreview),
  },
  {
    name: "accept",
    aliases: [],
    hidden: false,
    load: () => import("./review.ts").then((m) => m.accept),
  },
  {
    name: "doctor",
    aliases: [],
    hidden: false,
    load: () => import("./doctor.ts").then((m) => m.doctor),
  },
  {
    name: "config",
    aliases: [],
    hidden: false,
    load: () => import("./config.ts").then((m) => m.config),
  },
  { name: "init", aliases: [], hidden: false, load: () => import("./init.ts").then((m) => m.init) },
  { name: "lint", aliases: [], hidden: false, load: () => import("./lint.ts").then((m) => m.lint) },
  {
    name: "mcp-serve",
    aliases: [],
    hidden: true,
    load: () => import("./mcp-serve.ts").then((m) => m.mcpServe),
  },
];

type Invocation = {
  verb: string | null;
  rest: string[];
  help: boolean;
  version: boolean;
  quiet: boolean;
  json: boolean;
  dryRun: boolean;
};

// `-h`, `-v`, `--quiet`, `--json` and `--dry-run` are read off the raw argv before the verb's
// module loads and before any file is touched: help costs nothing and changes nothing, and the
// output mode is known before the strict parse can fail, so a usage error under --json is still
// one JSON value, under --quiet is still exit 0, and under --dry-run still writes no log line.
// Only whole argv words count, never letters inside a short group or an attached value
// (`-mprivacy` selects a memory, it does not ask for the version), and the verb is the first word
// that is not a flag; the flags a verb may precede are all booleans.
const SCAN_WORDS = new Map<string, keyof Omit<Invocation, "verb" | "rest">>([
  ["--help", "help"],
  ["-h", "help"],
  ["--version", "version"],
  ["-v", "version"],
  ["--quiet", "quiet"],
  ["--json", "json"],
  ["--dry-run", "dryRun"],
]);

function scan(argv: readonly string[]): Invocation {
  const invocation: Invocation = {
    verb: null,
    rest: [],
    help: false,
    version: false,
    quiet: false,
    json: false,
    dryRun: false,
  };
  let verbIndex = -1;
  for (const [index, word] of argv.entries()) {
    if (word === "--") break;
    const flag = SCAN_WORDS.get(word);
    if (flag !== undefined) invocation[flag] = true;
    else if (!word.startsWith("-") && invocation.verb === null) {
      invocation.verb = word;
      verbIndex = index;
    }
  }
  invocation.rest = argv.filter((_, index) => index !== verbIndex);
  return invocation;
}

// The words a bare `maxims` may carry and still mean "show help": the scan words plus the global
// booleans; anything else is a usage error, never help.
const GLOBAL_WORDS = new Set([...SCAN_WORDS.keys(), ...GLOBAL_FLAGS.map((f) => `--${f.name}`)]);

function findVerb(name: string): VerbEntry | undefined {
  return VERBS.find((entry) => entry.name === name || entry.aliases.includes(name));
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const io = deps.io;
  const invocation = scan(argv);
  const { quiet, json, dryRun } = invocation;
  const print = (plain: string, body: Record<string, unknown>): number => {
    io.stdout.write(json ? `${JSON.stringify({ ok: true, ...body }, null, 2)}\n` : plain);
    return ExitCode.Ok;
  };
  if (invocation.version) return print(`maxims ${VERSION}\n`, { version: VERSION });
  const entry = invocation.verb === null ? undefined : findVerb(invocation.verb);
  const failure: FailureContext = { io, quiet, json, dryRun, verb: invocation.verb ?? "maxims" };
  if (invocation.help) {
    const help = await helpText(entry);
    return print(help, { help });
  }
  if (invocation.verb === null) {
    const unknown = invocation.rest.find((word) => !GLOBAL_WORDS.has(word));
    if (unknown !== undefined) {
      return reportFailure(usage(`unknown option: ${unknown}`, { hint: STRINGS.runHelp }), failure);
    }
    const help = await helpText(undefined);
    return print(help, { help });
  }
  if (entry === undefined) {
    return reportFailure(
      usage(unknownCommand(invocation.verb), { hint: STRINGS.runHelp }),
      failure,
    );
  }
  const command = await entry.load();
  try {
    const args = parseVerbArgs(invocation.rest, command.flags);
    const extra = args.positionals[command.arity];
    if (extra !== undefined) throw usage(`unexpected argument: ${extra}`);
    const global = globalFlags(args);
    refuseJsonCombinations(command, args, json);
    const { engine, harnesses, resolvers } = await deps.loadEngine({ quiet });
    const ctx: CommandContext = {
      io: { ...io, harnesses, resolvers },
      engine,
      global,
      config: readConfig(io.home),
      openConsole: async (yes) => {
        const agent = deps.stdoutTty.isTTY && !quiet && !json ? await deps.detectAgent() : null;
        const mode = consoleMode({
          stdout: deps.stdoutTty,
          stdinTty: deps.stdinTty,
          agent,
          yes,
          quiet,
          json,
        });
        return createConsole({ mode, output: io.stdout, interactive: deps.interactive });
      },
    };
    const code = await command.run(args, ctx);
    if (code !== ExitCode.Ok && quiet) {
      await logQuietly(failure, `maxims: ${entry.name} exited ${code}`);
      return ExitCode.Ok;
    }
    return code;
  } catch (error) {
    return reportFailure(error, failure);
  }
}

// The quiet log is best effort: a home that cannot take the line must not turn a fail-soft exit
// into a thrown one. A dry run writes nothing, the log line and the home directory it would
// create included.
async function logQuietly(ctx: FailureContext, line: string): Promise<void> {
  if (ctx.dryRun) return;
  try {
    await appendRefreshLog(ctx.io.home, line);
  } catch {
    return;
  }
}

// `--json` promises one JSON value on stdout, which a prompt or a `--list` frame would break.
function refuseJsonCombinations(command: Command, args: Args, json: boolean): void {
  if (!json) return;
  const hasYes = command.flags.includes(FLAGS.yes);
  if (hasYes && !args.flag(FLAGS.yes) && !args.flag(FLAGS.all)) throw usage(STRINGS.jsonNeedsYes);
  if (command.flags.includes(FLAGS.list) && args.flag(FLAGS.list))
    throw usage(STRINGS.jsonWithList);
}

type FailureContext = {
  io: MachineIo;
  quiet: boolean;
  json: boolean;
  dryRun: boolean;
  verb: string;
};

// One place turns a thrown error into an exit code. Under `--quiet` every failure becomes exit 0
// after a log line: a session-start hook that exits non-zero renders an error in the user's
// transcript every session, and a broken hook must never break a session start. A failure the
// engine already printed (as its `--json` document or its interactive lines) is only mapped.
async function reportFailure(error: unknown, ctx: FailureContext): Promise<number> {
  const code = error instanceof MaximsError ? error.code : ExitCode.Usage;
  if (error instanceof ReportedMaximsError) return ctx.quiet ? ExitCode.Ok : code;
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof MaximsError ? error.hint : undefined;
  if (ctx.json) {
    const body = { ok: false, code, message, ...(hint === undefined ? {} : { hint }) };
    ctx.io.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  }
  if (ctx.quiet) {
    await logQuietly(ctx, `maxims: ${ctx.verb} failed (exit ${code}): ${message}`);
    return ExitCode.Ok;
  }
  if (ctx.json) return code;
  ctx.io.stderr.write(` ERROR  ${message}\n`);
  if (hint !== undefined) ctx.io.stderr.write(`Tip: ${hint}\n`);
  return code;
}

async function helpText(entry: VerbEntry | undefined): Promise<string> {
  if (entry !== undefined) return verbHelp(await entry.load());
  const lines = [
    `maxims ${VERSION}`,
    "One-line rule memories installed from GitHub repos into coding agents.",
    "",
    "Usage: maxims <command> [options]",
    "",
    "Commands:",
  ];
  const shown = VERBS.filter((v) => !v.hidden);
  const commands = await Promise.all(shown.map((v) => v.load()));
  const width = Math.max(...commands.map((c) => c.usage.length));
  commands.forEach((command, index) => {
    const entry = shown[index];
    const aliases =
      entry === undefined || entry.aliases.length === 0 ? "" : ` (${entry.aliases.join(", ")})`;
    lines.push(`  ${command.usage.padEnd(width)}  ${command.summary}${aliases}`);
  });
  lines.push("", "Global options:", ...flagLines([...GLOBAL_FLAGS, ...HELP_FLAGS]));
  return `${lines.join("\n")}\n`;
}

function verbHelp(command: Command): string {
  const lines = [`Usage: maxims ${command.usage} [options]`, "", command.summary, ""];
  if (command.flags.length > 0) lines.push("Options:", ...flagLines(command.flags), "");
  lines.push("Global options:", ...flagLines([...GLOBAL_FLAGS, ...HELP_FLAGS]));
  return `${lines.join("\n")}\n`;
}

// Listed in help only; `scan` recognizes them before any table is consulted.
const HELP_FLAGS: readonly FlagSpec[] = [
  { name: "help", short: "h", kind: "boolean", summary: "show help" },
  { name: "version", short: "v", kind: "boolean", summary: "print the version" },
];

function flagLines(flags: readonly FlagSpec[]): string[] {
  const rendered = flags.map((flag) => {
    const short = flag.short === undefined ? "    " : `-${flag.short}, `;
    const placeholder = flag.placeholder === undefined ? "" : ` ${flag.placeholder}`;
    return [`  ${short}--${flag.name}${placeholder}`, flag.summary] as const;
  });
  const width = Math.max(...rendered.map(([left]) => left.length));
  return rendered.map(([left, summary]) => `${left.padEnd(width)}  ${summary}`);
}
