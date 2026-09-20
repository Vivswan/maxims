import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";

export type FixtureRepo = {
  url: string;
  head: string;
  tagged: string;
};

// Two commits, an annotated tag on the first, an unrelated `src/` tree beside `memories/`, and a
// folder whose name starts like an option, so a sparse checkout has something to leave behind, a
// tag pin has something to differ from, and a memory path can look like a flag.
export async function createFixtureRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(join(dir, "memories"), { recursive: true });
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "-dashed"), { recursive: true });
  writeFileSync(join(dir, "memories", "first-rule.md"), "first\n");
  writeFileSync(join(dir, "-dashed", "odd-rule.md"), "odd\n");
  writeFileSync(join(dir, "src", "deep", "unrelated.txt"), "not a memory\n");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  const git = simpleGit(dir);
  await git.raw(["init", "--quiet", "-b", "main"]);
  await git.add(".");
  await git.commit("one");
  await git.addAnnotatedTag("v1", "first release");
  const tagged = (await git.revparse(["v1^{commit}"])).trim();
  writeFileSync(join(dir, "memories", "second-rule.md"), "second\n");
  await git.add(".");
  await git.commit("two");
  const head = (await git.revparse(["HEAD"])).trim();
  return { url: `file://${dir}`, head, tagged };
}
