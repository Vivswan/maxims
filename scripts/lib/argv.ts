import { type ParseArgsConfig, parseArgs } from "node:util";

/** A usage refusal: it reports the message with the usage text and never returns. */
export type Refuser = (message: string) => never;

// A flag given twice is two intents, so it is refused rather than resolved to the last one.
export function parseArgv<T extends ParseArgsConfig>(
  config: T,
  refuse: Refuser,
): ReturnType<typeof parseArgs<T & { tokens: true }>> {
  let parsed: ReturnType<typeof parseArgs<T & { tokens: true }>>;
  try {
    parsed = parseArgs({ ...config, tokens: true });
  } catch (error) {
    if (
      error instanceof TypeError &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS_")
    ) {
      refuse(error.message);
    }
    throw error;
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) refuse(`${token.rawName} given twice`);
    seen.add(token.name);
  }
  return parsed;
}

export function positiveInteger(flag: string, raw: string, refuse: Refuser): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    refuse(`${flag} must be a positive integer, got ${raw}`);
  return value;
}
