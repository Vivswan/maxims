import { readFileSync } from "node:fs";
import { z } from "zod";
import { HarnessIdSchema } from "../contracts/harness-id.ts";
import { flattenIssues } from "../util/zod-issues.ts";

// User defaults live in `<home>/config.json`, apart from state: state records what is installed,
// this records how the user likes to install. Strict, like state, so a misspelled key is refused
// rather than silently ignored.
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

export type ParsedUserConfig = { ok: true; config: UserConfig } | { ok: false; issues: string[] };

// `undefined` stands for an absent file and parses to the empty config.
export function parseUserConfig(json: unknown): ParsedUserConfig {
  const result = UserConfigSchema.safeParse(json === undefined ? {} : json);
  if (result.success) return { ok: true, config: result.data };
  return { ok: false, issues: flattenIssues(result.error.issues) };
}

// `issue` names the file and the key or parse error when the config could not be read as one;
// `config` is then the defaults. The one reader: whether a run refuses the file or runs on the
// defaults and says so is the verb's call, not the reader's. An absent file is the empty config.
type LoadedUserConfig = { config: UserConfig; issue: string | null };

export function readUserConfig(path: string): LoadedUserConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, issue: null };
    const detail = error instanceof Error ? error.message : String(error);
    return { config: {}, issue: `${path} could not be read (${detail})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { config: {}, issue: `${path} is not valid JSON: ${detail}` };
  }
  const parsed = parseUserConfig(json);
  if (parsed.ok) return { config: parsed.config, issue: null };
  return { config: {}, issue: `${path} is not a valid config: ${parsed.issues.join("; ")}` };
}
