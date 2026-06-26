/**
 * Parse the PR number from a Forgejo (`/pulls/{n}`) or GitHub (`/pull/{n}`) URL.
 * Anchoring to the `pull(s)` path segment avoids misreading numeric org/namespace
 * segments (e.g. `https://git.example.com/123/repo/pulls/42` → 42, not 123).
 * The trailing `(?:[/?#]|$)` guard means trailing slashes and query/fragment
 * suffixes are handled correctly — a naive `/\/(\d+)$/` would return 0 for
 * `…/pulls/42/` or `…/pulls/42?x=1`.
 * Pure function; safe to import for unit testing with no side effects.
 */
export function parsePrNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/(?:pull|pulls)\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}
