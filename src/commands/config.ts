import { invalidAgents } from "../console/strings.ts";
import {
  HARNESS_IDS,
  type HarnessId,
  isBuiltInHarnessId,
  parseUserHarnessId,
} from "../contracts/harness-id.ts";
import { type UserConfig, UserConfigSchema } from "../state/config.ts";
import { applyChanges } from "../util/change.ts";
import { ExitCode } from "../util/exit-codes.ts";
import { configWrite } from "./shared/cli-context.ts";
import {
  type Command,
  closestHarnessId,
  INTEGER,
  integerOrUsage,
  usage,
} from "./shared/options.ts";
import { finish } from "./shared/output.ts";

type ConfigKey = keyof UserConfig;

const KEYS = Object.keys(UserConfigSchema.shape) as ConfigKey[];

// A default may name a harness this machine has not declared yet, so the id is checked against
// the grammar (built-in or kebab-case user id), not against a registry.
function harnessIdOrUsage(raw: string): HarnessId {
  if (isBuiltInHarnessId(raw)) return raw;
  const user = parseUserHarnessId(raw);
  if (user !== null) return user;
  const closest = closestHarnessId(raw, HARNESS_IDS);
  throw usage(invalidAgents([raw], HARNESS_IDS, closest));
}

function keyOrUsage(raw: string | undefined): ConfigKey {
  const key = KEYS.find((candidate) => candidate === raw);
  if (key === undefined) {
    throw usage(`unknown config key: ${raw ?? "(none)"} (valid: ${KEYS.join(", ")})`);
  }
  return key;
}

// A value is parsed by the key's own schema and the WHOLE resulting object re-parsed before the
// write, so the file on disk is always one `parseUserConfig` accepts.
function valueFor(key: ConfigKey, raw: string): UserConfig[ConfigKey] {
  switch (key) {
    case "agents":
    case "lastAgents":
      return raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== "")
        .map(harnessIdOrUsage);
    case "yes":
    case "addHook":
    case "rule":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw usage(`${key} expects true or false, got "${raw}"`);
    case "cooldownDays":
      return integerOrUsage(raw, INTEGER.nonNegative, key);
    case "ruleCap":
      return integerOrUsage(raw, INTEGER.positive, key);
  }
}

export const config: Command = {
  summary: "read or write a user default in config.json",
  usage: "config <get|set|unset> [key] [value]",
  arity: 3,
  flags: [],
  async run(args, ctx) {
    const [action, rawKey, rawValue] = args.positionals;
    const expectedWords = action === "set" ? 3 : 2;
    const extra = args.positionals[action === "get" && rawKey === undefined ? 1 : expectedWords];
    if (extra !== undefined) throw usage(`unexpected argument: ${extra}`);
    const console = await ctx.openConsole(true);
    if (action === "get") {
      if (rawKey === undefined) {
        ctx.io.stdout.write(`${JSON.stringify(ctx.config, null, 2)}\n`);
        return ExitCode.Ok;
      }
      const value = ctx.config[keyOrUsage(rawKey)];
      if (value !== undefined) ctx.io.stdout.write(`${JSON.stringify(value)}\n`);
      else if (ctx.global.json) ctx.io.stdout.write("null\n");
      return ExitCode.Ok;
    }
    if (action !== "set" && action !== "unset") {
      throw usage(`config expects get, set or unset, got "${action ?? ""}"`, {
        hint: "maxims config set rule true",
      });
    }
    const key = keyOrUsage(rawKey);
    const next: UserConfig = { ...ctx.config };
    if (action === "set") {
      if (rawValue === undefined) throw usage(`config set ${key} needs a value`);
      const value = valueFor(key, rawValue);
      Object.assign(next, { [key]: value });
    } else {
      delete next[key];
    }
    const parsed = UserConfigSchema.safeParse(next);
    if (!parsed.success) {
      throw usage(
        `config would be invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        {
          hint: `agents and lastAgents take ${HARNESS_IDS.join(", ")}`,
        },
      );
    }
    const plan = { changes: [configWrite(ctx.io.home, parsed.data)], notices: [] };
    await applyChanges(plan, { dryRun: ctx.global.dryRun });
    return finish(ctx, console, {
      plan,
      notices: [],
      json: { config: parsed.data },
      lines: [action === "set" ? `${key} = ${JSON.stringify(parsed.data[key])}` : `${key} unset`],
    });
  },
};
