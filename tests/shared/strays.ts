import { lstatSync, rmSync, statSync } from "node:fs";
import { join, parse, relative, sep } from "node:path";

// A red run of a guard test writes exactly where the guard should have refused, inside the
// checkout; removing the shallowest ancestor that did not exist before takes everything such a run
// created and nothing that was already there. Descent stops at an entry that is not a directory,
// so a stray file or a dangling link is neither probed beneath nor removed.
export function removerOfCreated(paths: readonly string[]): () => void {
  const created = new Set<string>();
  for (const path of paths) {
    let current = parse(path).root;
    for (const segment of relative(current, path).split(sep)) {
      current = join(current, segment);
      if (lstatSync(current, { throwIfNoEntry: false }) === undefined) {
        created.add(current);
        break;
      }
      if (!statSync(current, { throwIfNoEntry: false })?.isDirectory()) break;
    }
  }
  return () => {
    for (const path of created) rmSync(path, { recursive: true, force: true });
  };
}
