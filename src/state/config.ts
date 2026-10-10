import { readFileSync } from "node:fs";
import { z } from "zod";
import { HarnessIdSchema } from "../contracts/harness-id.ts";
import { flattenIssues } from "../util/zod-issues.ts";
import { CONFIG_LADDER, CURRENT_CONFIG_VERSION, envelope } from "./migrations/config-ladder.ts";
import { migrate, versionOf } from "./migrations/runner.ts";

// User defaults live in `<home>/config.json`, apart from state: state records what is installed,
// this records how the user likes to install. Strict, like state, so a misspelled key is refused
// rather than silently ignored. These are the keys `config set` offers; the file carries them
// under the version envelope below, which is never a key.
export const UserConfigSchema = z.strictObject({
  agents: z.array(HarnessIdSchema).optional(),
  yes: z.boolean().optional(),
  addHook: z.boolean().optional(),
  rule: z.boolean().optional(),
  // Zero is a cooldown too: every sync refetches, which a CI runner or a tester wants.
  cooldownDays: z.number().int().nonnegative().optional(),
  ruleCap: z.number().int().positive().optional(),
  // The harnesses chosen at the last interactive prompt, pre-selected next time; a memory of a
  // choice, not a default, so `-a` and `agents` both win over it.
  lastAgents: z.array(HarnessIdSchema).optional(),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

const ConfigFileSchema = UserConfigSchema.extend({ version: z.literal(CURRENT_CONFIG_VERSION) });

export type ParsedUserConfig =
  | { ok: "parsed"; config: UserConfig }
  | { ok: "corrupt"; issues: string[] }
  | { ok: "newer"; version: number };

// `undefined` stands for an absent file and parses to the empty config. The version is judged as
// state's is: above the current one is a clean stop, since this maxims cannot see the keys a
// newer one wrote; below it climbs the ladder before the strict parse.
export function parseUserConfig(json: unknown): ParsedUserConfig {
  let document = envelope(json === undefined ? {} : json);
  const version = versionOf(document);
  if (version !== null && version > CURRENT_CONFIG_VERSION) return { ok: "newer", version };
  if (version !== null && version < CURRENT_CONFIG_VERSION) {
    const migration = migrate(document, version, CONFIG_LADDER);
    if (migration.kind === "unreachable") {
      return {
        ok: "corrupt",
        issues: [
          `version ${version} is older than any migration this maxims carries (oldest ${migration.oldest})`,
        ],
      };
    }
    document = migration.json;
  }
  const result = ConfigFileSchema.safeParse(document);
  if (!result.success) return { ok: "corrupt", issues: flattenIssues(result.error.issues) };
  const { version: _version, ...config } = result.data;
  return { ok: "parsed", config };
}

export function serializeUserConfig(config: UserConfig): string {
  return `${JSON.stringify({ version: CURRENT_CONFIG_VERSION, ...config }, null, 2)}\n`;
}

// The one reader of config.json. Whether a run refuses a file that could not be read as one or
// falls back to the defaults and says so is the verb's call (main.ts's table, loadContext), not
// the reader's.
export type LoadedUserConfig = { ok: true; config: UserConfig } | { ok: false; issue: string };

export function readUserConfig(path: string): LoadedUserConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, config: {} };
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, issue: `${path} could not be read (${detail})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, issue: `${path} is not valid JSON: ${detail}` };
  }
  const parsed = parseUserConfig(json);
  switch (parsed.ok) {
    case "parsed":
      return { ok: true, config: parsed.config };
    case "newer":
      return {
        ok: false,
        issue: `${path} was written by a newer maxims (config version ${parsed.version}); upgrade maxims to use it`,
      };
    case "corrupt":
      return { ok: false, issue: `${path} is not a valid config: ${parsed.issues.join("; ")}` };
  }
}
