import { z } from "zod";

// Every writer stamps `toISOString()`; a hand edit is the only way another precision reaches the
// file, and it is folded to the same form here so no two spellings of one instant ever meet in
// a comparison. Zod stops offsets at this boundary, so the fold never shifts the instant.
export const IsoTimestamp = z.iso.datetime().transform((value) => new Date(value).toISOString());

export const LAST_ERROR_KINDS = ["network", "ratelimit", "missing", "auth", "invalid"] as const;

export const LastErrorSchema = z.strictObject({
  kind: z.enum(LAST_ERROR_KINDS),
  message: z.string(),
  retryAfter: IsoTimestamp.optional(),
  at: IsoTimestamp,
});
export type LastError = z.infer<typeof LastErrorSchema>;
