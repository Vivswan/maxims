import { join, resolve } from "node:path";

// Unit tests mirror src/ under tests/, so fixture data stays beside the code that declares it and a
// test reaches it through here instead of counting `..` segments for its own depth.
export function srcPath(...segments: string[]): string {
  return join(resolve(import.meta.dir, "..", ".."), "src", ...segments);
}
