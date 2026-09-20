// The npm package is scoped (`@vivswan/maxims`, the bare name being blocked as too close to
// axios); the installed binary is still `maxims`. A command that must work where nothing is
// installed yet (the session-start hook, the provenance line a user copies out of a rule file)
// starts with this so it fetches the right package; hints addressed to an installed binary say
// `maxims` alone.
export const PACKAGE_ARGV = ["npx", "-y", "@vivswan/maxims"] as const;
export const PACKAGE_COMMAND = PACKAGE_ARGV.join(" ");
