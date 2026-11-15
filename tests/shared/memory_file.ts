import { stringify } from "yaml";
import type { MemoryType } from "../../src/memory/contract.ts";

export type MemorySpec = {
  description: string;
  body?: string;
  internal?: boolean;
  type?: MemoryType;
};

/** Returns the text of a memory file named `name` that passes the memory contract; the body defaults to one line naming the memory. */
export function memoryFile(name: string, spec: MemorySpec): string {
  const metadata = {
    node_type: "memory",
    ...(spec.type === undefined ? {} : { type: spec.type }),
    ...(spec.internal === true ? { internal: true } : {}),
  };
  // lineWidth 0: a long description stays on one line, as every fixture written by hand spelled it.
  const frontmatter = stringify(
    { name, description: spec.description, metadata },
    { lineWidth: 0 },
  );

  return `---\n${frontmatter}---\n\n${spec.body ?? `Body of ${name}.`}\n`;
}
