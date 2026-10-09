export const DEFAULT_GH_HOST = "github.com";
const GITHUB_LOCALHOST = "github.localhost";
const TENANCY_SUFFIX = ".ghe.com";

// gh's host classes (go-gh pkg/auth IsTenancy, IsEnterprise): github.com and every ghe.com tenant
// share one class, every other host is an enterprise server.
export function isDotcomClass(host: string): boolean {
  return host === DEFAULT_GH_HOST || host.endsWith(TENANCY_SUFFIX);
}

// go-gh's NormalizeHostname, so a GH_HOST means to maxims what it means to gh. The recorded host
// is what the fetch ladder builds its API URL and picks its token from, so an alias must fold
// before it is recorded: `api.github.com` kept verbatim would offer the enterprise token and
// request `https://api.github.com/api/v3/...`; `api.octo.ghe.com` kept verbatim would request
// `api.api.octo.ghe.com`. A tenancy host keeps only its last label before the suffix.
export function normalizeGithubHost(host: string): string {
  const hostname = host.toLowerCase();
  if (hostname.endsWith(`.${DEFAULT_GH_HOST}`)) return DEFAULT_GH_HOST;
  if (hostname.endsWith(`.${GITHUB_LOCALHOST}`)) return GITHUB_LOCALHOST;
  if (hostname.endsWith(TENANCY_SUFFIX)) {
    const before = hostname.slice(0, -TENANCY_SUFFIX.length);
    return `${before.slice(before.lastIndexOf(".") + 1)}${TENANCY_SUFFIX}`;
  }
  return hostname;
}
