# Extra — Forge providers (GitHub / Forgejo)

## What it adds

A **forge-provider seam** that lets Bottega drive pull requests against any
self-hosted [Forgejo](https://forgejo.org) instance (or Gitea-compatible API),
not just GitHub. The core loop is unchanged: planning → (implementation ⇄
review) → PR. Only the parts that talk to a *forge* — open the PR, read CI
status, merge, and the [PR-comment re-trigger](./pr-comment-retrigger.md)
webhook — are moved behind one interface with two implementations:
`GitHubProvider` (today's `gh` behavior, unchanged) and `ForgejoProvider`
(Forgejo `/api/v1` over `fetch`). A project picks its forge; everything else
stays the same.

## Why it's an extra (not core)

Core ends at "open the PR, drive CI green, signal done" and is deliberately
silent about *which* forge that is — same way it's silent about where task docs
come from ([`SPEC.md`](../SPEC.md), [`core/pull-request-agent.md`](../core/pull-request-agent.md)).
The reference implementation happens to be opinionated: it shells out to GitHub's
`gh` CLI everywhere. Targeting Forgejo, GitLab, or anything else is one team's
preference about where code lives. So forge selection is an extra. It changes
none of the orchestration state machine — it swaps the implementation behind the
PR agent's forge calls and generalizes the inbound webhook.

This extra also **supersedes the GitHub-only assumptions** baked into
[`extra/pr-comment-retrigger.md`](./pr-comment-retrigger.md): that doc describes
the GitHub webhook directly; this one describes the provider seam the webhook
should sit behind.

## The core insight: GitHub coupling lives in two execution contexts

The reference is coupled to GitHub in two *different* places, and an interface
that only covers backend code fixes just one of them:

| Context | Where (reference) | What it does |
|---|---|---|
| **Backend services** | [`reference/server/services/worktree.ts`](../reference/server/services/worktree.ts) (`createPullRequest`, `getPullRequestStatus`, `mergeAndCleanup`), [`reference/server/routes/webhooks.ts`](../reference/server/routes/webhooks.ts) (`fetchPrBranchName`, `fetchReviewComments`), [`reference/server/services/prService.ts`](../reference/server/services/prService.ts) | shell out to `gh pr create/view/checks/merge` and `gh api …/reviews/…` |
| **The agent's own shell** | the PR-agent prompt in [`reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts) | the coding agent **itself** runs `gh pr create` and `gh pr checks` inside its sandbox to self-drive PR creation and the "keep CI green" loop |

A backend `ForgeProvider` interface cleanly replaces the first row. But the
second row is *prompt text the LLM executes* — a backend interface can't reach
into the agent's shell. Both must be addressed, or the agent's self-driven loop
silently keeps calling `gh` against a forge that has no `gh`.

## The seam: one provider, consumed two ways

Define a single interface (host-agnostic argument shapes — `owner/repo`, branch,
PR number — never `gh`-specific flags):

```ts
interface ForgeProvider {
  createPR(ctx, { branch, title, body }): Promise<{ url: string; number: number }>;
  getPRStatus(ctx, { branch }): Promise<PullRequestStatusResult>; // existing shape
  mergePR(ctx, { prNumber }): Promise<void>;
  getPRBranch(ctx, { prNumber }): Promise<string | null>;
  getReviewComments(ctx, { prNumber, reviewId }): Promise<ReviewComment[]>;
}
```

`ctx` carries the resolved forge config (type, base URL, `owner/repo`, and the
caller's token — see [Configuration](#configuration-per-project-forge-per-user-token)).
`PullRequestStatusResult` and `CIStatus` keep the exact shapes already defined in
[`worktree.ts`](../reference/server/services/worktree.ts) so nothing downstream
changes.

Two implementations:

- **`GitHubProvider`** — moves the current `gh …` shell-outs behind the
  interface, byte-for-byte the same commands. Existing behavior, now swappable
  and testable. This is a pure refactor; GitHub users see no change.
- **`ForgejoProvider`** — calls Forgejo's REST API over `fetch`:

  | Method | Forgejo endpoint |
  |---|---|
  | `createPR` | `POST /api/v1/repos/{owner}/{repo}/pulls` |
  | `getPRStatus` | `GET .../pulls?head={branch}` then `GET .../commits/{sha}/status` for CI |
  | `mergePR` | `POST .../pulls/{n}/merge` |
  | `getPRBranch` | `GET .../pulls/{n}` → `head.ref` |
  | `getReviewComments` | `GET .../pulls/{n}/reviews/{id}/comments` |

### Consumed two ways

1. **Backend services import it.** `worktree.ts` / `webhooks.ts` / `prService.ts`
   resolve the provider for the task's project and call it instead of running
   `gh` inline.

2. **The agent calls a thin CLI wrapper.** Add `reference/scripts/forge.ts` —
   `tsx scripts/forge.ts pr create …`, `… pr checks …` — that dispatches through
   the *same* provider. The PR-agent prompt swaps `gh pr create …` →
   `tsx <path>/forge.ts pr create …` and `gh pr checks` → `… pr checks`. **This
   reuses an existing pattern:** the agent already runs `tsx scripts/complete-pr.ts`
   and `complete-workflow.ts` ([`reference/scripts/`](../reference/scripts)). The
   orchestration loop is untouched; only the command name in the prompt changes,
   and the agent stops needing `gh` in its sandbox.

> **Why the wrapper instead of moving PR creation into the backend?** Keeping
> the agent the actor preserves the self-driving "open PR → poll CI → fix →
> repeat" loop exactly as core describes it. The wrapper is the smallest change
> that makes that loop forge-agnostic. One `ForgeProvider`, two entry points.

## Configuration: per-project forge, per-user token

A Bottega instance can host projects on different forges, so selection is
**per-project**, not a global env var.

- **Project columns** (extend the `projects` table — see
  [`reference/server/database/init.sql`](../reference/server/database/init.sql)):
  - `forge_type` — `'github' | 'forgejo'`, default `'github'`.
  - `forge_base_url` — e.g. `https://git.example.com` (ignored for GitHub).
- **Token — per user**, mirroring Bottega's per-user Claude OAuth model
  ([`extra/auth-and-multi-user.md`](./auth-and-multi-user.md),
  [`reference/server/services/claudeCredentials.ts`](../reference/server/services/claudeCredentials.ts)):
  each user stores their own Forgejo PAT in the per-user credentials dir, so PRs
  are attributed to the real author and the multi-user identity model holds.
  GitHub keeps its existing per-user `GH_CONFIG_DIR` / `GITHUB_TOKEN` path
  unchanged.
- **Resolution:** given a task → project → `forge_type` + `forge_base_url`, plus
  the acting user's token → a `ForgeProvider` and `ctx`. A `forgeProvider`
  factory centralizes this so callers never branch on forge type themselves.

## Inbound webhooks: normalize, don't fork the handler

The [PR-comment re-trigger](./pr-comment-retrigger.md) route stays one endpoint;
two forge-specific concerns get isolated behind small functions in
[`reference/server/services/webhookService.ts`](../reference/server/services/webhookService.ts)
and [`reference/server/routes/webhooks.ts`](../reference/server/routes/webhooks.ts):

- **Signature.** GitHub signs with `X-Hub-Signature-256` (`sha256=` + HMAC).
  Forgejo signs the raw body with HMAC-SHA256 in `X-Forgejo-Signature` /
  `X-Gitea-Signature` (hex, **no** `sha256=` prefix). The route selects the
  validator by which header is present; both still verify against the **raw
  request bytes** (the existing `express.raw` mounting is unchanged and
  essential — HMAC is byte-sensitive).
- **Payload.** A `normalizeWebhookEvent(forgeType, headers, payload)` maps each
  forge's event into the internal shape
  `{ kind: 'comment' | 'review', prUrl, prNumber, branch, bodyText, comments[] }`
  that `triggerPrAgentFromComment` / `triggerPrAgentFromReview` already consume.
  Forgejo's `issue_comment` / `pull_request_review` payloads differ in field
  names and nesting from GitHub's but carry the same facts.
- **Already forge-agnostic:** `parseTaskIdFromBranch` (the `task/{id}-{slug}`
  regex) and the configurable `@`-trigger from `app_settings` need no change.
- Fetching review-comment bodies for Forgejo goes through
  `ForgejoProvider.getReviewComments`, not `gh api`.

## CI status — the known risk, made explicit

The PR agent's "keep CI green" loop depends on per-PR check status. GitHub
exposes it via `gh pr checks`; Forgejo exposes the **combined commit status**:

```
GET /api/v1/repos/{owner}/{repo}/commits/{sha}/status
  → { state: 'success' | 'pending' | 'failure' | 'error', statuses: [...] }
```

`ForgejoProvider.getPRStatus` maps `state` into the existing `CIStatus`
(`passed` / `pending` / `failed`) and `statuses[]` into `CICheck[]`. **Caveat:**
this assumes the repo actually reports commit statuses — via Forgejo Actions or
an external CI posting statuses through the API. A Forgejo repo with no
status-reporting CI yields "no checks," and the loop treats it as nothing to wait
on — the same degradation GitHub has with no Actions configured. Document this in
the project's setup notes; it is a deployment prerequisite, not a code bug.

## Testing

- A **provider contract test** both implementations satisfy (same expectations,
  swapped backend), honoring the repo gate
  ([`reference/scripts/gate.sh`](../reference/scripts/gate.sh)).
- `ForgejoProvider` tested against mocked `fetch` (request shape + response
  mapping), `GitHubProvider` against mocked `runCommand` (its existing test
  doubles, see [`reference/server/services/worktree.test.ts`](../reference/server/services/worktree.test.ts)).
- Webhook normalizer tested with captured Forgejo `issue_comment` /
  `pull_request_review` payloads and a known-good HMAC, alongside the existing
  GitHub cases in
  [`reference/server/routes/webhooks.test.ts`](../reference/server/routes/webhooks.test.ts).
- `scripts/forge.ts` argv parsing + dispatch tested independently of the network.

## Non-goals

- GitLab, Bitbucket, or other forges — the seam makes them possible later, but
  this extra ships GitHub + Forgejo only.
- Migrating an existing project's host, or provisioning push credentials / SSH
  keys for the worktree (git push is already forge-agnostic and out of scope).
- A global single-bot token, or any opt-out flag on the GitHub path — GitHub
  behavior is preserved by `GitHubProvider`, not by branches in call sites.

## Key files (reference)

- [`reference/server/services/worktree.ts`](../reference/server/services/worktree.ts) — `createPullRequest`, `getPullRequestStatus`, `mergeAndCleanup`, `CIStatus`
- [`reference/server/routes/webhooks.ts`](../reference/server/routes/webhooks.ts) — webhook route, `fetchPrBranchName`, `fetchReviewComments`
- [`reference/server/services/webhookService.ts`](../reference/server/services/webhookService.ts) — signature validation, `parseTaskIdFromBranch`, trigger logic
- [`reference/server/services/prService.ts`](../reference/server/services/prService.ts) — PR-creation entry point
- [`reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts) — the PR-agent prompt that runs `gh`
- [`reference/scripts/complete-pr.ts`](../reference/scripts/complete-pr.ts) — the agent-invoked CLI pattern `forge.ts` follows
- [`reference/server/database/init.sql`](../reference/server/database/init.sql) — `projects` schema to extend
