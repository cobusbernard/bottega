# Agentic Loop

This document covers the six agent types, the auto-chaining state machine, YOLO mode,
prompt templates and user overrides, per-agent model and effort settings, git worktrees,
and GitHub/Forgejo webhook callbacks.

> **Key files**: `server/services/agentRunner.ts`, `server/constants/agentPrompts.ts`,
> `server/constants/prompts/`, `server/services/forge/`, `server/routes/webhooks.ts`.

## Forge selection

Each project can be pinned to a **forge connection** (admin-configured via
Settings → Forge Connections). Connections are either `github` or `forgejo` type.

### How the agent CLI is chosen

`resolveForgeCli(taskId)` (in `server/services/forge/index.ts`) reads the project's
`forge_connection_id` and returns:

- `'gh'` — for GitHub connections, or when no connection is pinned (default).
- `'forge'` — for Forgejo connections.

`agentRunner.ts` translates this into the string the agent calls:

- **GitHub**: `gh` — the standard GitHub CLI.
- **Forgejo**: `tsx /home/ubuntu/bottega/reference/scripts/forge.ts` — a thin wrapper
  script that calls the Forgejo REST API. The agent receives `forgeArgs` (e.g.
  ` --user 5 --task 1`) appended directly, so `gh pr checks` has no trailing space
  and Forgejo renders `tsx …/forge.ts pr checks --user 5 --task 1`.

The PR, YOLO, and PR-feedback prompts all use `{{forgeCli}} pr checks{{forgeArgs}}`
(no space before `{{forgeArgs}}`); `forgeArgs` carries its own leading space when
non-empty.

### Fallback behaviour

When a project has no pinned connection, `resolveForgeProvider` falls back to the
first enabled **GitHub** connection. If none exists it synthesises a GitHub default.
Forgejo connections are intentionally skipped in the fallback because without an
explicit pin there is no way to know which Forgejo instance owns the repository —
the same reasoning that makes `resolveForgeCli` return `'gh'` for unpinned projects.

### Deployment prerequisite for Forgejo

For the "keep CI green" loop to work on Forgejo, the repository **must report commit
statuses** to the Forgejo instance. This is typically done via Forgejo Actions or an
external CI system (Jenkins, Woodpecker, etc.) configured to push status checks.
Without commit statuses, `tsx forge.ts pr checks` will report no checks and the agent
will proceed immediately as if CI passed.

### Per-connection bot token

Admins can store a bot token per Forgejo connection
(`PUT /api/admin/forge-connections/:id/token`). This token is used by the
PR-comment webhook handler (`server/routes/webhooks.ts`) to:

1. Resolve the PR branch from a Forgejo `issue_comment` event (Forgejo comments do
   not include the branch name in the payload, unlike GitHub).
2. Fetch inline review comments when a `pull_request_review` event arrives, so they
   are forwarded to the PR agent alongside the review body.

Without the bot token, Forgejo `issue_comment` webhooks are silently dropped.
`pull_request_review` events are still processed (the review body alone is enough to
trigger the agent), but inline comments will be absent.
