import { existsSync } from "node:fs";
import { join } from "node:path";
import { STRINGS } from "../console/strings.ts";
import { type MemoryName, parseMemory, parseMemoryName } from "../memory/contract.ts";
import { applyChanges, type Plan } from "../util/change.ts";
import { ExitCode, MaximsError } from "../util/exit-codes.ts";
import { assertInsideRoot } from "../util/fs.ts";
import { type Command, usage } from "./shared/options.ts";
import { finish } from "./shared/output.ts";

// The scaffold every new memory starts from; it passes the contract as written, so `lint` on a
// fresh folder is clean and only the placeholder text asks to be replaced. The name is quoted
// because a bare `true`, `null` or `123` is a valid memory name and an invalid YAML string.
export function memoryTemplate(name: MemoryName): string {
  return [
    "---",
    `name: "${name}"`,
    'description: "Use when ... - one line, the part that must always be in context"',
    "metadata:",
    "  node_type: memory",
    "  type: feedback",
    "---",
    "",
    "**Why:** the reason this rule exists, in one or two sentences.",
    "",
    "**How to apply:** what to do the moment it triggers.",
    "",
  ].join("\n");
}

export const init: Command = {
  summary: "scaffold a contract-valid memory file under memories/",
  usage: "init [name]",
  arity: 1,
  flags: [],
  async run(args, ctx) {
    const console = await ctx.openConsole(false);
    const name = await memoryName(args.positionals[0], console);
    const dir = join(ctx.io.cwd, "memories");
    const relPath = join("memories", `${name}.md`);
    const path = assertInsideRoot(ctx.io.cwd, join(dir, `${name}.md`));
    if (existsSync(path)) throw new MaximsError(ExitCode.Usage, `${relPath} already exists`);
    const content = memoryTemplate(name);
    const parsed = parseMemory(path, content);
    if (!parsed.ok)
      throw new Error(`the init template fails the memory contract: ${parsed.reason}`);
    const plan: Plan = {
      changes: [
        { kind: "mkdir", path: assertInsideRoot(ctx.io.cwd, dir) },
        { kind: "write", path, content },
      ],
      notices: [],
    };
    await applyChanges(plan, { dryRun: ctx.global.dryRun });
    return finish(ctx, console, {
      plan,
      notices: [],
      json: { path: relPath, name },
      lines: [`Created ${relPath}`],
    });
  },
};

async function memoryName(
  positional: string | undefined,
  console: Awaited<ReturnType<Parameters<Command["run"]>[1]["openConsole"]>>,
): Promise<MemoryName> {
  if (positional !== undefined) {
    const name = parseMemoryName(positional);
    if (name === null) throw usage(`"${positional}" is not a kebab-case memory name`);
    return name;
  }
  const answer = await console.text({
    message: "Memory name (kebab-case)",
    initial: "",
    validate: (value) => (parseMemoryName(value) === null ? STRINGS.expectedMemoryName : undefined),
  });
  const name = answer === null ? null : parseMemoryName(answer);
  if (name === null) {
    throw usage("a memory name is required", { hint: "maxims init <name>" });
  }
  return name;
}
