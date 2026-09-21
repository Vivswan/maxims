import { z } from "zod";
import { HarnessIdSchema } from "../contracts/harness-id.ts";

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
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const where = issue.path.map(String).join(".");
      return where === "" ? issue.message : `${where}: ${issue.message}`;
    }),
  };
}
