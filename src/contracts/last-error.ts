// The failure a source's last fetch left, as state.json records it. `IsoTimestamp` folds every
// spelling of an instant to the form every writer stamps, `toISOString()`, so no two spellings of
// one instant meet in a comparison.
//   a hand edit   the only way another precision reaches the file
//   an offset     zod stops it at this boundary, so the fold never shifts the instant

import { z } from "zod";

export const IsoTimestamp = z.iso.datetime().transform((value) => new Date(value).toISOString());

export const LAST_ERROR_KINDS = ["network", "ratelimit", "missing", "auth", "invalid"] as const;

export const LastErrorSchema = z.strictObject({
  kind: z.enum(LAST_ERROR_KINDS),
  message: z.string(),
  retryAfter: IsoTimestamp.optional(),
  at: IsoTimestamp,
});
export type LastError = z.infer<typeof LastErrorSchema>;
