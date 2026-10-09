// A child that must behave the same on every machine gets only the variables it needs to start
// and to find its tools; everything else the caller's shell exports stays behind.
const INHERITED_ENV = ["PATH", "HOME", "TMPDIR", "LANG"] as const;

export function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
