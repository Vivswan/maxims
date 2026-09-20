import type { z } from "zod";

// Union and record issues nest the branch that actually failed one level down; the flattened
// text names it so a refusal can say which key was wrong rather than "invalid input".
export function flattenIssues(issues: z.core.$ZodIssue[], prefix: PropertyKey[] = []): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      return issue.errors.flatMap((branch) => flattenIssues(branch, path));
    }
    if (issue.code === "invalid_key" || issue.code === "invalid_element") {
      return flattenIssues(issue.issues, path);
    }
    const where = path.map(String).join(".");
    return [where === "" ? issue.message : `${where}: ${issue.message}`];
  });
}
