import type { Console } from "../../console/contract.ts";
import { installed, STRINGS } from "../../console/strings.ts";
import { ExitCode } from "../../util/exit-codes.ts";
import { type Args, type Command, FLAGS, type FlagSpec } from "../frame/options.ts";
import { finish, mergePlans } from "../frame/output.ts";
import { commitAdd, registeredLines, syncCommitted } from "./commit.ts";
import { planAdd, provenanceFor, showProvenance } from "./plan.ts";
import { parseAddRequest } from "./request.ts";
import { stageAdd } from "./stage.ts";

const ADD_FLAGS: readonly FlagSpec[] = [
  FLAGS.global,
  FLAGS.project,
  FLAGS.out,
  FLAGS.memory,
  FLAGS.agent,
  FLAGS.list,
  FLAGS.yes,
  FLAGS.all,
  FLAGS.rule,
  FLAGS.addHook,
  FLAGS.copy,
  FLAGS.from,
  FLAGS.fullDepth,
  FLAGS.link,
  FLAGS.share,
  FLAGS.pin,
  FLAGS.paths,
  FLAGS.auth,
  FLAGS.rename,
  FLAGS.allowHidden,
  FLAGS.strict,
  FLAGS.review,
  FLAGS.cooldown,
  FLAGS.cap,
  FLAGS.noFetch,
];

// A preview installs nothing, so the flags that shape an install have nothing to act on.
function warnIgnoredWithList(args: Args, console: Console): void {
  for (const spec of [FLAGS.rule, FLAGS.addHook, FLAGS.yes]) {
    if (args.flag(spec)) console.warn(`--${spec.name} is ignored with --list`);
  }
  if (args.value(FLAGS.out) !== undefined) console.warn("--out is ignored with --list");
}

export const add: Command = {
  summary: "fetch a source, record it in state, then sync",
  usage: "add <source>",
  arity: 1,
  flags: ADD_FLAGS,
  async run(args, ctx) {
    const request = await parseAddRequest(args, ctx);
    const yes = args.flag(FLAGS.yes) || args.flag(FLAGS.all) || ctx.config.yes === true;
    const console = await ctx.openConsole(yes);
    console.intro();
    if (request.list) warnIgnoredWithList(args, console);
    const stage = await stageAdd(request, ctx, console);
    if (stage.kind === "store-empty") {
      return finish(ctx, console, {
        plan: { changes: [], notices: [] },
        notices: [],
        json: { source: request.key, memories: [], harnesses: [] },
        lines: [STRINGS.storeEmpty],
      });
    }
    // A preview has no plan to sit above, and its output is the specified listing.
    const provenance = request.list ? null : provenanceFor(stage.staged);
    if (provenance !== null) showProvenance(console, provenance);
    const outcome = await planAdd(stage.staged, ctx, console, []);
    if (outcome.kind !== "prepared") return ExitCode.Ok;
    const { prepared } = outcome;
    const commit = await commitAdd([prepared], ctx, { writeManifest: true });
    const report = await syncCommitted(ctx, commit, commit.harnesses);
    const planned = ctx.global.dryRun;
    const lines = [installed(prepared.names.length, report.rules, report.tokens, planned)];
    for (const line of registeredLines(commit.hooked, planned)) lines.push(line);
    const code = finish(ctx, console, {
      plan: mergePlans({ changes: commit.changes, notices: [] }, report.plan),
      notices: [...commit.notices, ...report.notices],
      json: {
        source: prepared.request.key,
        memories: prepared.names,
        harnesses: prepared.harnesses.ids,
        warnings: prepared.warnings,
        provenance,
      },
      lines,
    });
    if (!ctx.global.json && !ctx.global.quiet) console.gap();
    return code;
  },
};
