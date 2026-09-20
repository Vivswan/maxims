import type { ConsoleMode } from "./contract.ts";

export type ModeInput = {
  stdout: { isTTY?: boolean; columns?: number };
  stdinTty: boolean;
  agent: string | null;
  yes: boolean;
  quiet: boolean;
  json: boolean;
};

const DEFAULT_WIDTH = 80;

export function consoleMode(input: ModeInput): ConsoleMode {
  const tty = input.stdout.isTTY === true;
  return {
    tty,
    stdinTty: input.stdinTty,
    agent: tty ? input.agent : null,
    yes: input.yes,
    quiet: input.quiet,
    json: input.json,
    width: tty && input.stdout.columns !== undefined ? input.stdout.columns : DEFAULT_WIDTH,
  };
}

export type DetectedAgent = { isAgent: boolean; agent: { name: string } | undefined };

// Cursor's IDE sets CURSOR_TRACE_ID in every integrated terminal, so a human typing there would
// otherwise be treated as an agent and lose every prompt; only the Cursor agent surfaces count,
// which the detector reports as "cursor-cli".
export function agentIdFrom(detected: DetectedAgent): string | null {
  if (!detected.isAgent || detected.agent === undefined) return null;
  return detected.agent.name === "cursor" ? null : detected.agent.name;
}

export async function detectAgent(): Promise<string | null> {
  const { determineAgent } = await import("@vercel/detect-agent");
  return agentIdFrom(await determineAgent());
}
