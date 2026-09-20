import { z } from "zod";
import { HARNESS_IDS } from "../harnesses/contract.ts";

// User defaults live in `<home>/config.json`, apart from state: state records what is installed,
// this records how the user likes to install. Strict, like state, so a misspelled key is refused
// rather than silently ignored.
export const UserConfigSchema = z.strictObject({
  agents: z.array(z.enum(HARNESS_IDS)).optional(),
  yes: z.boolean().optional(),
  addHook: z.boolean().optional(),
  rule: z.boolean().optional(),
  cooldownDays: z.number().int().positive().optional(),
  ruleCap: z.number().int().positive().optional(),
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
