// The container image declares this variable (tests/container/Dockerfile), so every process in
// a container run sees it and nothing outside one does: the tests that drive the image's
// installed harness CLIs run when it is set and skip by name otherwise.
export const CONTAINER_TIER_ENV = "MAXIMS_CONTAINER_TIER";

export function inContainerTier(env: Record<string, string | undefined>): boolean {
  return env[CONTAINER_TIER_ENV] === "1";
}
