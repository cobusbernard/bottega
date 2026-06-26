# Extra — Forge providers (GitHub / Forgejo)

## What it adds

A **forge-provider seam** that lets Bottega drive pull requests against any
self-hosted [Forgejo](https://forgejo.org) instance (or Gitea-compatible API),
not just GitHub. The core loop is unchanged: planning → (implementation ⇄
review) → PR. Only the parts that talk to a *forge* — open the PR, read CI
status, merge, and the [PR-comment re-trigger](./pr-comment-retrigger.md)
webhook — move behind one interface with two implementations: `GitHubProvider`
(today's `gh` behavior, unchanged) and `ForgejoProvider` (Forgejo `/api/v1` over
`fetch`).

Forge selection is **per project**. An admin **connects GitHub and/or Forgejo
once** in the admin panel; each project then **picks which connected forge it
uses**; each user supplies **their own token** for that forge so PRs are
attributed to the real author. The PR agent's prompts render the **correct CLI
per project** — `gh` for GitHub projects, `forge` for Forgejo projects.

## Why it's an extra (not core)

Core ends at "open the PR, drive CI green, signal done" and is deliberately
silent about *which* forge that is — the same way it's silent about where task
docs come from ([`SPEC.md`](../SPEC.md),
[`core/pull-request-agent.md`](../core/pull-request-agent.md)). The reference
implementation is opinionated: it shells out to GitHub's `gh` CLI everywhere.
Targeting Forgejo, GitLab, or anything else is one team's preference about where
code lives. So forge selection is an extra. It changes none of the orchestration
state machine — it swaps the implementation behind the PR agent's forge calls
and generalizes the inbound webhook.

This extra **supersedes the GitHub-only assumptions** in
[`extra/pr-comment-retrigger.md`](./pr-comment-retrigger.md): that doc describes
the GitHub webhook directly; this one describes the provider seam the webhook
should sit behind.

## The core insight: GitHub coupling lives in two execution contexts

The reference is coupled to GitHub in two *different* places, and an interface
that only covers backend code fixes just one of them:

| Context | Where (reference) | What it does |
| --- | --- | --- |
| **Backend services** | [`worktree.ts`](../reference/server/services/worktree.ts) (`createPullRequest`, `getPullRequestStatus`, `mergeAndCleanup`), [`routes/webhooks.ts`](../reference/server/routes/webhooks.ts) (`fetchPrBranchName`, `fetchReviewComments`), [`prService.ts`](../reference/server/services/prService.ts) | shell out to `gh pr create/view/checks/merge` and `gh api …/reviews/…` |
| **The agent's own shell** | the PR-agent prompt in [`agentPrompts.ts`](../reference/server/constants/agentPrompts.ts) | the coding agent **itself** runs `gh pr create` and `gh pr checks` inside its sandbox to self-drive PR creation and the "keep CI green" loop |

A backend interface cleanly replaces the first row. But the second row is
*prompt text the LLM executes* — a backend interface can't reach into the
agent's shell. Both must be addressed, or the agent's self-driven loop silently
keeps calling `gh` against a forge that has no `gh`.

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

`ctx` carries the resolved forge config — connection type, base URL, `owner/repo`,
and the acting user's token (see [Configuration](#configuration-admin-connections--per-project-selection--per-user-tokens)).
`PullRequestStatusResult` and `CIStatus` keep the exact shapes already defined in
[`worktree.ts`](../reference/server/services/worktree.ts) so nothing downstream
changes.

Two implementations:

- **`GitHubProvider`** — moves the current `gh …` shell-outs behind the
  interface, byte-for-byte the same commands. Existing behavior, now swappable
  and testable. A pure refactor; GitHub users see no change.
- **`ForgejoProvider`** — calls Forgejo's REST API over `fetch`:

  | Method | Forgejo endpoint |
  | --- | --- |
  | `createPR` | `POST /api/v1/repos/{owner}/{repo}/pulls` |
  | `getPRStatus` | `GET .../pulls?head={branch}` then `GET .../commits/{sha}/status` for CI |
  | `mergePR` | `POST .../pulls/{n}/merge` |
  | `getPRBranch` | `GET .../pulls/{n}` → `head.ref` |
  | `getReviewComments` | `GET .../pulls/{n}/reviews/{id}/comments` |

### Consumed two ways

1. **Backend services import it.** `worktree.ts` / `webhooks.ts` / `prService.ts`
   resolve the provider for the task's project and call it instead of running
   `gh` inline.

2. **The agent calls the right CLI per project.** GitHub projects keep using the
   real `gh` binary already present in the sandbox. Forgejo projects use
   **`forge`** — a small Bottega-shipped command
   ([`reference/scripts/forge.ts`](../reference/scripts), exposed on the agent's
   `PATH`) that dispatches through the *same* `ForgejoProvider` over REST, so no
   third-party binary or per-user `tea login` is needed in the sandbox. The
   PR-agent prompt **renders the command name from the project's forge type**
   (see [Forge-aware prompts](#forge-aware-prompt-templates)). This reuses an
   existing pattern: the agent already runs `tsx scripts/complete-pr.ts` and
   `complete-workflow.ts`.

> **Why `forge`, not `fg`?** `fg` is a shell job-control builtin — `bash -c "fg
> pr create …"` runs the builtin, never a `PATH` binary, so it would fail with
> `fg: no job control`. `forge` has no such collision and reads naturally
> alongside `gh`.
>
> **Why a CLI wrapper instead of moving PR creation into the backend?** Keeping
> the agent the actor preserves the self-driving "open PR → poll CI → fix →
> repeat" loop exactly as core describes it. The wrapper is the smallest change
> that makes that loop forge-agnostic. One `ForgeProvider`, two entry points.

## Configuration: admin connections → per-project selection → per-user tokens

Three layers, each owned by the right role. A Bottega instance can host projects
on different forges, so nothing here is a single global env var.

### 1. Admin connects the forges (new admin-settings section)

A new **Forge connections** panel under Admin
([`extra/auth-and-multi-user.md`](./auth-and-multi-user.md) describes the admin
surface). An admin registers one or more connections — **GitHub, Forgejo, or
both** — each a row in a new `forge_connections` table:

| Column | Meaning |
| --- | --- |
| `id` | connection id (referenced by projects) |
| `type` | `'github'` \| `'forgejo'` |
| `name` | display label, e.g. "Corp Forgejo" |
| `base_url` | API base, e.g. `https://git.example.com` (GitHub defaults to `github.com`/GHES host) |
| `enabled` | toggles availability without deleting |

"Connect" means: create the record (and, for Forgejo, confirm `base_url` is
reachable via a health probe). The connection holds the **server identity, not a
shared secret** — individual auth is per user (layer 3). New endpoints live
behind the existing admin authorization guard; their request bodies are
validated by zod schemas in `shared/schemas/` like every other route
([`reference/CLAUDE.md`](../reference/CLAUDE.md) — "API request validation").

### 2. Each project selects a connection

Add `projects.forge_connection_id` (FK → `forge_connections.id`; see
[`reference/server/database/init.sql`](../reference/server/database/init.sql)).
The project create/edit form gains a **Forge** dropdown listing *enabled*
connections. To preserve current behavior, an instance with a single GitHub
connection makes it the default, and existing projects backfill to it — so a
pure-GitHub deployment behaves exactly as today.

### 3. Each user supplies their own token

Per-user, per-connection credentials — mirroring Bottega's per-user Claude OAuth
model ([`reference/server/services/claudeCredentials.ts`](../reference/server/services/claudeCredentials.ts)):
a `user_forge_credentials(user_id, forge_connection_id, token)` record, the
token stored in the per-user credentials dir, not the database in plaintext. A
user connects their account from **Settings → Connect forge**, picking a
connection the admin enabled and pasting a PAT (GitHub may continue to use its
existing per-user `GH_CONFIG_DIR` / `GITHUB_TOKEN` path). PRs are then attributed
to the real author, and the multi-user identity model holds.

### Resolution

`task → project → forge_connection (type, base_url) + acting user's token for
that connection → ForgeProvider + ctx`. A single `resolveForgeProvider(taskId,
userId)` factory centralizes this so no call site ever branches on forge type.

## Forge-aware prompt templates

The PR-agent prompt currently hardcodes `gh` ([`agentPrompts.ts`](../reference/server/constants/agentPrompts.ts);
prompts are markdown templates, not string literals —
[`extra/prompt-and-model-customization.md`](./prompt-and-model-customization.md)).
Make the forge command a **template variable** resolved from the project's
connection type at render time:

- The prompt renderer injects `forgeCli` (`'gh'` for GitHub projects, `'forge'`
  for Forgejo) and a matching `forgeRepoFlag` where one is needed.
- Templates reference `{{forgeCli}} pr create …`, `{{forgeCli}} pr checks …`,
  `{{forgeCli}} pr view …` instead of a literal `gh`.
- Both CLIs expose the **same `pr create | view | checks | merge` subcommand
  surface** (the `forge` wrapper deliberately mirrors `gh`'s shape), so the
  template text differs only by the command name and the prompt logic stays
  identical across forges.
- User prompt overrides keep working — an override that hardcodes `gh` still
  runs on GitHub projects; teams targeting Forgejo switch theirs to
  `{{forgeCli}}`.

This is the change that makes the *agent's* loop forge-correct; the
`ForgeProvider` seam makes the *backend's* loop forge-correct. Both are required.

## Inbound webhooks: normalize, don't fork the handler

The [PR-comment re-trigger](./pr-comment-retrigger.md) stays one endpoint; two
forge-specific concerns get isolated behind small functions in
[`webhookService.ts`](../reference/server/services/webhookService.ts) and
[`routes/webhooks.ts`](../reference/server/routes/webhooks.ts):

- **Signature.** GitHub signs with `X-Hub-Signature-256` (`sha256=` + HMAC).
  Forgejo signs the raw body with HMAC-SHA256 in `X-Forgejo-Signature` /
  `X-Gitea-Signature` (hex, **no** `sha256=` prefix). The route selects the
  validator by which header is present; both verify against the **raw request
  bytes** (the existing `express.raw` mounting is unchanged and essential — HMAC
  is byte-sensitive).
- **Payload.** A `normalizeWebhookEvent(connectionType, headers, payload)` maps
  each forge's event into the internal shape
  `{ kind: 'comment' | 'review', prUrl, prNumber, branch, bodyText, comments[] }`
  that `triggerPrAgentFromComment` / `triggerPrAgentFromReview` already consume.
  Forgejo's `issue_comment` / `pull_request_review` payloads differ in field
  names and nesting from GitHub's but carry the same facts. The webhook maps to a
  project (hence a connection) by repo, so the right validator/normalizer is
  chosen per delivery.
- **Already forge-agnostic:** `parseTaskIdFromBranch` (the `task/{id}-{slug}`
  regex) and the configurable `@`-trigger from `app_settings` need no change.
- Fetching review-comment bodies for Forgejo goes through
  `ForgejoProvider.getReviewComments`, not `gh api`.

## CI status — the known risk, made explicit

The PR agent's "keep CI green" loop depends on per-PR check status. GitHub
exposes it via `gh pr checks`; Forgejo exposes the **combined commit status**:

```text
GET /api/v1/repos/{owner}/{repo}/commits/{sha}/status
  → { state: 'success' | 'pending' | 'failure' | 'error', statuses: [...] }
```

`ForgejoProvider.getPRStatus` (and `forge pr checks`) map `state` into the
existing `CIStatus` (`passed` / `pending` / `failed`) and `statuses[]` into
`CICheck[]`. **Caveat:** this assumes the repo actually reports commit statuses —
via Forgejo Actions or an external CI posting statuses through the API. A Forgejo
repo with no status-reporting CI yields "no checks," and the loop treats it as
nothing to wait on — the same degradation GitHub has with no Actions configured.
Document this in the project's setup notes; it is a deployment prerequisite, not
a code bug.

## Testing

- A **provider contract test** both implementations satisfy (same expectations,
  swapped backend), honoring the repo gate
  ([`reference/scripts/gate.sh`](../reference/scripts/gate.sh)).
- `ForgejoProvider` tested against mocked `fetch` (request shape + response
  mapping), `GitHubProvider` against mocked `runCommand` (its existing test
  doubles — [`worktree.test.ts`](../reference/server/services/worktree.test.ts)).
- Webhook normalizer tested with captured Forgejo `issue_comment` /
  `pull_request_review` payloads and a known-good HMAC, alongside the existing
  GitHub cases in [`webhooks.test.ts`](../reference/server/routes/webhooks.test.ts).
- Prompt renderer tested to emit `gh` for a GitHub-connection project and `forge`
  for a Forgejo-connection project.
- `forge` (`scripts/forge.ts`) argv parsing + dispatch tested independently of
  the network.
- Admin connection + per-user credential routes tested through their zod schemas.

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
- [`reference/server/services/promptRenderer.ts`](../reference/server/services/promptRenderer.ts) — prompt template engine (inject `forgeCli`)
- [`reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts) — the PR-agent prompt that runs `gh`
- [`reference/scripts/complete-pr.ts`](../reference/scripts/complete-pr.ts) — the agent-invoked CLI pattern `forge` follows
- [`reference/server/database/init.sql`](../reference/server/database/init.sql) — `projects` schema + new `forge_connections` / `user_forge_credentials` tables
- [`reference/server/services/claudeCredentials.ts`](../reference/server/services/claudeCredentials.ts) — per-user credential storage pattern to mirror
