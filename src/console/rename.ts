import { type MemoryName, parseMemoryName } from "../memory/contract.ts";
import type { Console } from "./contract.ts";
import { alreadyInstalled, STRINGS } from "./strings.ts";

export type Collision = {
  name: MemoryName;
  ownedBy: string;
};

export type RenameAnswer =
  | { kind: "renamed"; rename: Record<MemoryName, MemoryName> }
  | { kind: "declined" };

// The dedupe prompt: one `text` per colliding memory, defaulting to `<name>-<suffix>` where the
// suffix is the incoming source's repo name, validated as a memory name that no installed or
// incoming memory already uses. Any null answer (a non-interactive mode, or a cancel) declines the
// whole batch, because a half-renamed source would be exactly the partial install exit 6 exists to
// refuse.
export async function promptRenames(
  console: Console,
  collisions: readonly Collision[],
  suffix: string,
  taken: ReadonlySet<string>,
): Promise<RenameAnswer> {
  const rename: Record<MemoryName, MemoryName> = {};
  const used = new Set(taken);
  for (const collision of collisions) {
    const answer = await console.text({
      message: alreadyInstalled(collision.name, collision.ownedBy),
      initial: `${collision.name}-${suffix}`,
      validate: (value) => {
        if (parseMemoryName(value) === null) return STRINGS.expectedMemoryName;
        if (used.has(value)) return `${value} is already taken`;
        return undefined;
      },
    });
    const parsed = answer === null ? null : parseMemoryName(answer);
    if (parsed === null || used.has(parsed)) return { kind: "declined" };
    used.add(parsed);
    rename[collision.name] = parsed;
  }
  return { kind: "renamed", rename };
}
