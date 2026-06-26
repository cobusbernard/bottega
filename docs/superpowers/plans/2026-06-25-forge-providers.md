# Forge Providers (GitHub / Forgejo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Bottega drive pull requests, CI status, merges, and the PR-comment re-trigger webhook against a self-hosted Forgejo (Gitea-compatible) instance as well as GitHub, selected per project.

**Architecture:** Introduce one `ForgeProvider` interface with two implementations — `GitHubProvider` (wraps today's `gh` shell-outs, unchanged) and `ForgejoProvider` (Forgejo `/api/v1` over `fetch`). Backend services call the provider; the PR agent calls the right CLI per project (`gh` or a Bottega-shipped `forge` wrapper). Forge servers are connected once in Admin, selected per project, and authenticated per user.

**Tech Stack:** TypeScript (strict, `allowJs:false`), Node + Express + `ws`, better-sqlite3, Vitest, React 18 + Vite + Tailwind. Forge calls via global `fetch`. No new runtime deps unless a task says so.

**Spec:** [`extra/forge-providers.md`](../../../extra/forge-providers.md)

## Global Constraints

- **TypeScript-only.** No new `.js`/`.jsx` files (the `pnpm guard-no-js` prelint hook fails CI otherwise). Source is `.ts`/`.tsx`.
- **Validation at the boundary.** Every route reading `req.body/params/query` validates through a zod schema in `shared/schemas/`, wired via `validateBody/validateParams/validateQuery` (see `reference/CLAUDE.md`). No ad-hoc shape checks.
- **The gate is the definition of done.** After every task, `bash scripts/gate.sh` (run from `reference/`) must exit 0. It runs `pnpm install --frozen-lockfile`, `pnpm test:run`, `tsc --noEmit`, `pnpm lint`.
- **Per-task single-file test command:** `pnpm vitest run <path/to/file.test.ts>` (watch-free). Use `-t "<name>"` to target one test.
- **No behavior change for GitHub.** `GitHubProvider` issues byte-for-byte the same `gh` commands as today; a pure-GitHub instance must behave identically.
- **Secrets never in SQLite plaintext.** Per-user forge tokens live in the per-user credentials dir, mirroring `claudeCredentials.ts`.
- **All paths below are relative to `reference/`.**

---

## Phase 1 — The provider seam + GitHub refactor (no behavior change)

Goal of phase: extract every backend `gh` call behind `ForgeProvider`, with `GitHubProvider` reproducing current behavior. Ends with a green gate and zero functional change.

### Task 1: Define the `ForgeProvider` interface and shared types

**Files:**
- Create: `server/services/forge/types.ts`
- Test: `server/services/forge/types.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ForgeContext {
    type: 'github' | 'forgejo';
    baseUrl: string;        // 'https://github.com' or e.g. 'https://git.example.com'
    owner: string;
    repo: string;
    token: string | null;   // acting user's token; null => provider falls back to ambient gh auth
    worktreePath: string;    // cwd for git/gh operations
  }
  export interface CreatePRArgs { branch: string; title: string; body: string; }
  export interface CreatePRResultProvider { url: string; number: number | null; }
  export interface ReviewCommentProvider {
    body?: string; user?: { login?: string }; path?: string;
    line?: number | null; start_line?: number | null;
    diff_hunk?: string | null; side?: string | null;
  }
  // Re-export the EXISTING shapes from worktree.ts unchanged:
  //   PullRequestStatusResult, CIStatus, CICheck
  export interface ForgeProvider {
    createPR(ctx: ForgeContext, args: CreatePRArgs): Promise<CreatePRResultProvider>;
    getPRStatus(ctx: ForgeContext, args: { branch: string | null }): Promise<PullRequestStatusResult>;
    mergePR(ctx: ForgeContext, args: { prNumber: number }): Promise<void>;
    getPRBranch(ctx: ForgeContext, args: { prNumber: number; repoFullName: string }): Promise<string | null>;
    getReviewComments(ctx: ForgeContext, args: { prNumber: number; reviewId: number; repoFullName: string }): Promise<ReviewCommentProvider[]>;
  }
  ```
  Import `PullRequestStatusResult`, `CIStatus`, `CICheck` from `../worktree.js` and re-export, so there is a single source of truth.

- [ ] **Step 1: Write the failing test** — assert the module exports the interface-bearing types by constructing a typed stub.

```ts
// server/services/forge/types.test.ts
import { describe, it, expect } from 'vitest';
import type { ForgeProvider, ForgeContext } from './types.js';

describe('ForgeProvider types', () => {
  it('a stub satisfies the interface and ForgeContext shape', () => {
    const ctx: ForgeContext = {
      type: 'github', baseUrl: 'https://github.com', owner: 'o', repo: 'r',
      token: null, worktreePath: '/tmp/wt',
    };
    const stub: ForgeProvider = {
      createPR: async () => ({ url: 'u', number: 1 }),
      getPRStatus: async () => ({ success: true, exists: false }),
      mergePR: async () => undefined,
      getPRBranch: async () => null,
      getReviewComments: async () => [],
    };
    expect(ctx.type).toBe('github');
    expect(typeof stub.createPR).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/services/forge/types.test.ts`
Expected: FAIL — `Cannot find module './types.js'`.

- [ ] **Step 3: Write `types.ts`** with the interface block above (importing/re-exporting `PullRequestStatusResult`, `CIStatus`, `CICheck` from `../worktree.js`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/services/forge/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/forge/types.ts server/services/forge/types.test.ts
git commit -m "feat(forge): define ForgeProvider interface and shared types"
```

### Task 2: Implement `GitHubProvider` by lifting the existing `gh` calls

**Files:**
- Create: `server/services/forge/githubProvider.ts`
- Test: `server/services/forge/githubProvider.test.ts`
- Reference (copy command shapes verbatim): `server/services/worktree.ts:348-461` (`createPullRequest`, `getPullRequestStatus`), `:466-535` (`mergeAndCleanup`'s `gh pr merge`), `server/routes/webhooks.ts` (`fetchPrBranchName`, `fetchReviewComments`).

**Interfaces:**
- Consumes: `ForgeProvider`, `ForgeContext` (Task 1); `runCommand` from `../shell.js`.
- Produces: `export const githubProvider: ForgeProvider;`

The five methods run exactly the commands that exist today, with `cwd: ctx.worktreePath`:
- `createPR`: `git push -u origin <branch>` then `gh ['pr','create','--title',title,'--body',body]`; return `{ url: stdout.trim(), number: null }`.
- `getPRStatus`: `gh ['pr','view','--json','url,state,mergeable']` + `gh ['pr','checks','--json','bucket,name,state,link']`, mapping buckets to `CIStatus` exactly as `worktree.ts:428-447` does (preserve the `code === 8 => pending` branch).
- `mergePR`: `gh ['pr','merge','--merge']`.
- `getPRBranch`: `gh ['pr','view',String(prNumber),'--repo',repoFullName,'--json','headRefName','--jq','.headRefName']`.
- `getReviewComments`: `gh ['api', 'repos/${repoFullName}/pulls/${prNumber}/reviews/${reviewId}/comments']` then `JSON.parse`.

- [ ] **Step 1: Write the failing test** — mock `runCommand`, assert exact argv.

```ts
// server/services/forge/githubProvider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const runCommand = vi.fn();
vi.mock('../shell.js', () => ({ runCommand }));
import { githubProvider } from './githubProvider.js';
import type { ForgeContext } from './types.js';

const ctx: ForgeContext = {
  type: 'github', baseUrl: 'https://github.com', owner: 'o', repo: 'r',
  token: null, worktreePath: '/tmp/wt',
};

beforeEach(() => runCommand.mockReset());

describe('githubProvider', () => {
  it('createPR pushes then runs gh pr create and returns the url', async () => {
    runCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                              // git push
      .mockResolvedValueOnce({ stdout: 'https://github.com/o/r/pull/7\n', stderr: '' }); // gh pr create
    const res = await githubProvider.createPR(ctx, { branch: 'task/7-x', title: 'T', body: 'B' });
    expect(res.url).toBe('https://github.com/o/r/pull/7');
    expect(runCommand).toHaveBeenNthCalledWith(1, 'git', ['push', '-u', 'origin', 'task/7-x'], { cwd: '/tmp/wt' });
    expect(runCommand).toHaveBeenNthCalledWith(2, 'gh', ['pr', 'create', '--title', 'T', '--body', 'B'], { cwd: '/tmp/wt' });
  });

  it('getReviewComments calls gh api with the reviews path', async () => {
    runCommand.mockResolvedValueOnce({ stdout: '[]', stderr: '' });
    const out = await githubProvider.getReviewComments(ctx, { prNumber: 42, reviewId: 9, repoFullName: 'o/r' });
    expect(out).toEqual([]);
    expect(runCommand).toHaveBeenCalledWith('gh', ['api', 'repos/o/r/pulls/42/reviews/9/comments']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/services/forge/githubProvider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `githubProvider.ts`** — the five methods exactly as described, copying the `CIStatus` mapping from `worktree.ts:428-447`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/services/forge/githubProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/forge/githubProvider.ts server/services/forge/githubProvider.test.ts
git commit -m "feat(forge): GitHubProvider wrapping existing gh calls"
```

### Task 3: Route `worktree.ts` and `webhooks.ts` through `githubProvider`

**Files:**
- Modify: `server/services/worktree.ts` (`createPullRequest:348`, `getPullRequestStatus:405`, the `gh pr merge` in `mergeAndCleanup:480`)
- Modify: `server/routes/webhooks.ts` (`fetchPrBranchName`, `fetchReviewComments`)
- Tests: existing `server/services/worktree.test.ts`, `server/routes/webhooks.test.ts` must stay green unchanged.

**Interfaces:**
- Consumes: `githubProvider` (Task 2). For this phase, call it directly (the per-project resolver arrives in Phase 2). Build a `ForgeContext` from the worktree: `{ type:'github', baseUrl:'https://github.com', owner:'', repo:'', token:null, worktreePath }` — owner/repo unused by the GitHub path (it operates from `cwd`), so empty strings are acceptable until Phase 2.

- [ ] **Step 1: Run the existing suites to confirm the baseline is green**

Run: `pnpm vitest run server/services/worktree.test.ts server/routes/webhooks.test.ts`
Expected: PASS (baseline).

- [ ] **Step 2: Replace the inline `gh` bodies with provider delegation**, keeping each exported function's signature identical. Example for `createPullRequest`:

```ts
// worktree.ts — body of createPullRequest after resolving `branch`
const ctx = { type: 'github' as const, baseUrl: 'https://github.com', owner: '', repo: '', token: null, worktreePath };
try {
  const { url } = await githubProvider.createPR(ctx, { branch, title, body });
  return { success: true, url };
} catch (error) {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}
```
Do the equivalent for `getPullRequestStatus` (delegate to `githubProvider.getPRStatus`) and the `gh pr merge` step in `mergeAndCleanup` (delegate to `githubProvider.mergePR`). In `webhooks.ts`, replace the `runCommand('gh', …)` bodies of `fetchPrBranchName`/`fetchReviewComments` with `githubProvider.getPRBranch`/`getReviewComments` (keep the existing `assertValid*` validation before the call).

- [ ] **Step 3: Run the suites to verify no behavior changed**

Run: `pnpm vitest run server/services/worktree.test.ts server/routes/webhooks.test.ts`
Expected: PASS (the existing tests assert the same `gh` argv, now produced via the provider).

- [ ] **Step 4: Full gate**

Run: `bash scripts/gate.sh`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/services/worktree.ts server/routes/webhooks.ts
git commit -m "refactor(forge): route backend gh calls through githubProvider (no behavior change)"
```

---

## Phase 2 — Configuration: connections, per-user tokens, resolver

### Task 4: `forge_connections` and `user_forge_credentials` schema + db helpers

**Files:**
- Modify: `server/database/init.sql` (after the `projects` block, ~line 39; add a column to `projects`)
- Modify: `server/database/db.ts` (add `forgeConnectionsDb` helpers; export types)
- Test: `server/database/forgeConnections.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ForgeConnectionRow {
    id: number; type: 'github' | 'forgejo'; name: string;
    base_url: string; enabled: 0 | 1; created_at: string;
  }
  export const forgeConnectionsDb: {
    list(): ForgeConnectionRow[];
    listEnabled(): ForgeConnectionRow[];
    getById(id: number): ForgeConnectionRow | undefined;
    create(input: { type: 'github'|'forgejo'; name: string; base_url: string }): ForgeConnectionRow;
    setEnabled(id: number, enabled: boolean): void;
    remove(id: number): void;
  };
  ```
- Schema additions:
  ```sql
  CREATE TABLE IF NOT EXISTS forge_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('github','forgejo')),
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  ALTER TABLE projects ADD COLUMN forge_connection_id INTEGER
      REFERENCES forge_connections(id);
  ```
  > **Migration note:** `init.sql` is idempotent (`IF NOT EXISTS`), but `ALTER TABLE … ADD COLUMN` is not. Guard it the way existing additive columns are guarded in this repo — check `db.ts` for the established pattern (a `PRAGMA table_info(projects)` check before `ALTER`). Follow that pattern; do not invent a new migration mechanism.

- [ ] **Step 1: Write the failing test**

```ts
// server/database/forgeConnections.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase, forgeConnectionsDb } from './db.js';

beforeEach(() => initializeDatabase());

describe('forgeConnectionsDb', () => {
  it('creates, lists, toggles, and removes a Forgejo connection', () => {
    const c = forgeConnectionsDb.create({ type: 'forgejo', name: 'Corp', base_url: 'https://git.example.com' });
    expect(c.id).toBeGreaterThan(0);
    expect(forgeConnectionsDb.listEnabled().some(r => r.id === c.id)).toBe(true);
    forgeConnectionsDb.setEnabled(c.id, false);
    expect(forgeConnectionsDb.listEnabled().some(r => r.id === c.id)).toBe(false);
    forgeConnectionsDb.remove(c.id);
    expect(forgeConnectionsDb.getById(c.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/database/forgeConnections.test.ts`
Expected: FAIL — `forgeConnectionsDb` undefined.

- [ ] **Step 3: Add the schema (with the guarded `ALTER`) and the `forgeConnectionsDb` helpers** in `db.ts`, following the prepared-statement style of the existing `*Db` objects.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/database/forgeConnections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/database/init.sql server/database/db.ts server/database/forgeConnections.test.ts
git commit -m "feat(forge): forge_connections table, projects.forge_connection_id, db helpers"
```

### Task 5: Per-user forge token storage

**Files:**
- Create: `server/services/forgeCredentials.ts`
- Test: `server/services/forgeCredentials.test.ts`
- Reference pattern: `server/services/claudeCredentials.ts` (per-user dir under `~/.config/bottega/users/{userId}/`).

**Interfaces:**
- Produces:
  ```ts
  export function setForgeToken(userId: number, connectionId: number, token: string): void;
  export function getForgeToken(userId: number, connectionId: number): string | null;
  export function deleteForgeToken(userId: number, connectionId: number): void;
  ```
  Store one file per `(userId, connectionId)`, e.g. `…/users/{userId}/forge_tokens/{connectionId}` with `0600` perms — mirror how `claudeCredentials.ts` derives its base dir (reuse its directory helper rather than re-deriving the path).

- [ ] **Step 1: Write the failing test**

```ts
// server/services/forgeCredentials.test.ts
import { describe, it, expect } from 'vitest';
import { setForgeToken, getForgeToken, deleteForgeToken } from './forgeCredentials.js';

describe('forgeCredentials', () => {
  it('round-trips a token per (user, connection)', () => {
    setForgeToken(1, 5, 'pat_abc');
    expect(getForgeToken(1, 5)).toBe('pat_abc');
    expect(getForgeToken(1, 6)).toBeNull();
    deleteForgeToken(1, 5);
    expect(getForgeToken(1, 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/forgeCredentials.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** using `fs` + the credentials base-dir helper from `claudeCredentials.ts`. Create dirs recursively; write with `{ mode: 0o600 }`; `getForgeToken` returns `null` on `ENOENT`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/services/forgeCredentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/forgeCredentials.ts server/services/forgeCredentials.test.ts
git commit -m "feat(forge): per-user per-connection token storage"
```

### Task 6: `resolveForgeProvider(taskId, userId)` factory

**Files:**
- Create: `server/services/forge/index.ts`
- Test: `server/services/forge/index.test.ts`

**Interfaces:**
- Consumes: `forgeConnectionsDb` (Task 4), `getForgeToken` (Task 5), `githubProvider` (Task 2), `forgejoProvider` (Task 7 — import lazily/by reference; the factory selects by `type`), `tasksDb`/`projectsDb` to map task→project→connection and to read `repo_folder_path`. Derive `owner/repo` from the connection + repo (for GitHub, parse from the worktree's `origin` remote via existing helpers; for Forgejo, required — see Task 7).
- Produces:
  ```ts
  export interface ResolvedForge { provider: ForgeProvider; ctx: ForgeContext; cli: 'gh' | 'forge'; }
  export async function resolveForgeProvider(taskId: number, userId: number): Promise<ResolvedForge>;
  ```
  Resolution: task → project → `forge_connection_id`. If null, fall back to the single enabled GitHub connection, else a synthetic GitHub default (`type:'github', baseUrl:'https://github.com'`) so pure-GitHub installs need no config. `cli` is `'gh'` for GitHub, `'forge'` for Forgejo.

- [ ] **Step 1: Write the failing test** (mock the db + credentials modules).

```ts
// server/services/forge/index.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../database/db.js', () => ({
  tasksDb: { getById: () => ({ id: 1, project_id: 9 }) },
  projectsDb: { getById: () => ({ id: 9, repo_folder_path: '/repo', forge_connection_id: null }) },
  forgeConnectionsDb: { getById: () => undefined, listEnabled: () => [] },
}));
vi.mock('../forgeCredentials.js', () => ({ getForgeToken: () => null }));
import { resolveForgeProvider } from './index.js';

describe('resolveForgeProvider', () => {
  it('defaults to GitHub when the project has no connection', async () => {
    const r = await resolveForgeProvider(1, 100);
    expect(r.cli).toBe('gh');
    expect(r.ctx.type).toBe('github');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/forge/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** the factory with the resolution rules above.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/services/forge/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/forge/index.ts server/services/forge/index.test.ts
git commit -m "feat(forge): resolveForgeProvider factory (task -> project -> connection)"
```

---

## Phase 3 — ForgejoProvider (REST over fetch)

### Task 7: `ForgejoProvider`

**Files:**
- Create: `server/services/forge/forgejoProvider.ts`
- Test: `server/services/forge/forgejoProvider.test.ts`

**Interfaces:**
- Consumes: `ForgeProvider`, `ForgeContext` (Task 1). Uses global `fetch`. Auth header: `Authorization: token ${ctx.token}` (Forgejo's PAT scheme). API root: `${ctx.baseUrl}/api/v1`.
- Produces: `export const forgejoProvider: ForgeProvider;`
- Endpoint mapping:
  - `createPR`: the branch must already be pushed (git push stays in the caller for parity, matching `githubProvider`). First `GET /repos/{owner}/{repo}` → read `default_branch`, then `POST /repos/{owner}/{repo}/pulls` body `{ head: branch, base: default_branch, title, body }`. Return `{ url: json.html_url, number: json.number }`.
  - `getPRStatus`: `GET /repos/{owner}/{repo}/pulls?state=open` and find the PR whose `head.ref === branch` (Forgejo lacks a reliable `head=` filter across versions; filter client-side). If none → `{ success:true, exists:false }`. Else read `head.sha`, then `GET /repos/{owner}/{repo}/commits/{sha}/status` → map `state` (`success→passed`, `pending→pending`, `failure|error→failed`) and `statuses[]` → `CICheck[]` (`{ bucket, name: context, state, link: target_url }`). Map `mergeable` (boolean) → `'MERGEABLE'|'CONFLICTING'` to match the existing `mergeable` string field consumers expect.
  - `mergePR`: `POST /repos/{owner}/{repo}/pulls/{n}/merge` body `{ Do: 'merge' }`.
  - `getPRBranch`: `GET /repos/{owner}/{repo}/pulls/{n}` → `head.ref`.
  - `getReviewComments`: `GET /repos/{owner}/{repo}/pulls/{n}/reviews/{reviewId}/comments` → map each to `ReviewCommentProvider` (`body`, `user.login`→`user.login`, `path`, `original_position`/`line`→`line`, `diff_hunk`).
  - Non-2xx → throw `Error('Forgejo <method> <path> failed: <status> <text>')`.

- [ ] **Step 1: Write the failing test** (stub global `fetch`).

```ts
// server/services/forge/forgejoProvider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { forgejoProvider } from './forgejoProvider.js';
import type { ForgeContext } from './types.js';

const ctx: ForgeContext = {
  type: 'forgejo', baseUrl: 'https://git.example.com', owner: 'o', repo: 'r',
  token: 'pat', worktreePath: '/tmp/wt',
};
const json = (body: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response);

beforeEach(() => { (globalThis as any).fetch = vi.fn(); });

describe('forgejoProvider', () => {
  it('createPR reads default branch then POSTs a pull and returns html_url', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockReturnValueOnce(json({ default_branch: 'main' }))                               // GET repo
      .mockReturnValueOnce(json({ html_url: 'https://git.example.com/o/r/pulls/3', number: 3 })); // POST pulls
    const res = await forgejoProvider.createPR(ctx, { branch: 'task/3-x', title: 'T', body: 'B' });
    expect(res).toEqual({ url: 'https://git.example.com/o/r/pulls/3', number: 3 });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://git.example.com/api/v1/repos/o/r/pulls');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ head: 'task/3-x', base: 'main', title: 'T', body: 'B' });
    expect(init.headers.Authorization).toBe('token pat');
  });

  it('getPRStatus maps a failing commit status to failed', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockReturnValueOnce(json([{ number: 3, head: { ref: 'task/3-x', sha: 'abc' }, html_url: 'u', state: 'open', mergeable: true }]))
      .mockReturnValueOnce(json({ state: 'failure', statuses: [{ context: 'ci', status: 'failure', target_url: 'l' }] }));
    const s = await forgejoProvider.getPRStatus(ctx, { branch: 'task/3-x' });
    expect(s.exists).toBe(true);
    expect(s.ciStatus?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/forge/forgejoProvider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `forgejoProvider.ts`** with a private `api(ctx, method, path, body?)` helper that sets `Authorization: token`, `Content-Type: application/json`, throws on non-2xx, and returns parsed JSON; then the five methods per the mapping above.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/services/forge/forgejoProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the resolver** — update `server/services/forge/index.ts` to return `forgejoProvider` + `cli:'forge'` when `connection.type === 'forgejo'`, building `ctx` with `baseUrl: connection.base_url`, `owner/repo` parsed from the project (store/derive `owner/repo`; if not derivable from a Forgejo remote, read it from the worktree's `origin` URL with a small parser). Add a resolver test for the forgejo branch.

Run: `pnpm vitest run server/services/forge/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/forge/forgejoProvider.ts server/services/forge/forgejoProvider.test.ts server/services/forge/index.ts server/services/forge/index.test.ts
git commit -m "feat(forge): ForgejoProvider over /api/v1 + resolver wiring"
```

---

## Phase 4 — The `forge` CLI + forge-aware prompts

### Task 8: `scripts/forge.ts` wrapper command

**Files:**
- Create: `scripts/forge.ts`
- Test: `scripts/forge.test.ts`
- Reference pattern: `scripts/complete-pr.ts` (argv parsing, exit codes, DB init).

**Interfaces:**
- CLI surface mirroring the `gh` subcommands the prompts use, so templates differ only by command name:
  - `forge pr create --title <t> --body <b>` → resolve provider for the cwd's task, `createPR`, print the PR URL.
  - `forge pr checks` → print a human table of `CIStatus.checks` and exit non-zero if any failed (mirror `gh pr checks` exit semantics: 0 pass, 8 pending, 1 fail) so the prompt's existing logic still reads exit codes.
  - `forge pr view --json <fields>` → print JSON with the requested subset of `{ url, state, mergeable, mergeStateStatus }`.
  - `forge pr merge` → `mergePR`.
  The task id comes from the branch (`parseTaskIdFromBranch`) or a `--task <id>` flag; the user id from a `--user <id>` flag the agent runner injects (the runner already knows the acting user).
- Produces: a runnable `tsx scripts/forge.ts …` entry; export `parseForgeArgv(argv: string[]): { cmd: string; sub: string; flags: Record<string,string|boolean> }` for unit testing.

- [ ] **Step 1: Write the failing test** for argv parsing (network-free).

```ts
// scripts/forge.test.ts
import { describe, it, expect } from 'vitest';
import { parseForgeArgv } from './forge.js';

describe('parseForgeArgv', () => {
  it('parses `pr create --title T --body B`', () => {
    const r = parseForgeArgv(['pr', 'create', '--title', 'T', '--body', 'B']);
    expect(r).toEqual({ cmd: 'pr', sub: 'create', flags: { title: 'T', body: 'B' } });
  });
  it('parses `pr checks`', () => {
    expect(parseForgeArgv(['pr', 'checks'])).toEqual({ cmd: 'pr', sub: 'checks', flags: {} });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run scripts/forge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/forge.ts`** — export `parseForgeArgv`, then a `main()` that resolves the provider (`resolveForgeProvider`) and dispatches. Guard `main()` behind an `import.meta`-style entry check so importing the module for tests does not execute it (follow `complete-pr.ts`'s structure).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run scripts/forge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/forge.ts scripts/forge.test.ts
git commit -m "feat(forge): forge CLI wrapper mirroring gh pr subcommands"
```

### Task 9: Make the PR prompts forge-aware via a `forgeCli` variable

**Files:**
- Modify: `server/constants/agentPrompts.ts` (`buildPrCreateOrVerifyBlock:43`, `generatePrAgentMessage:90`, `generateYoloMessage:103`, the comment/review generators that render `pr-feedback`)
- Modify: `server/constants/prompts/pr.md`, `prompts/yolo.md`, `prompts/pr-feedback.md` (replace literal `gh` with `{{forgeCli}}`)
- Modify: `server/services/promptRenderer.ts` (add `forgeCli` to the `variables` lists of `pr`, `yolo`, `pr-feedback`)
- Modify the callers in `server/services/agentRunner.ts` to pass the resolved `cli`.
- Tests: `server/constants/agentPrompts.test.ts`, `server/services/promptRenderer.test.ts`

**Interfaces:**
- Consumes: `ResolvedForge.cli` (Task 6).
- Produces: `generatePrAgentMessage(taskDocPath, taskId, prUrl, forgeCli)` (new trailing param, default `'gh'` to keep existing callers/tests compiling until updated). Same for `generateYoloMessage`, `generatePrAgentCommentMessage`, `generatePrAgentReviewMessage`. `buildPrCreateOrVerifyBlock(taskId, prUrl, forgeCli)` emits `${forgeCli} pr create …`.

- [ ] **Step 1: Write the failing test** — assert `gh` vs `forge` rendering.

```ts
// add to server/constants/agentPrompts.test.ts
it('renders the forge CLI in the create block', async () => {
  const gh = await generatePrAgentMessage('/doc.md', 1, null, 'gh');
  expect(gh).toContain('gh pr create');
  const fg = await generatePrAgentMessage('/doc.md', 1, null, 'forge');
  expect(fg).toContain('forge pr create');
  expect(fg).not.toContain('gh pr create');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/constants/agentPrompts.test.ts -t "forge CLI"`
Expected: FAIL — `forge pr create` not present (still hardcoded `gh`).

- [ ] **Step 3: Implement** — thread `forgeCli` through the generators and `buildPrCreateOrVerifyBlock`; replace `gh` with `{{forgeCli}}` in `pr.md`, `yolo.md`, `pr-feedback.md`; add `forgeCli` to those three prompts' `variables` arrays in `promptRenderer.ts`. In `agentRunner.ts`, call `resolveForgeProvider(taskId, userId)` and pass `.cli`.

> **Known divergence — flag, don't silently break:** `pr.md`/`pr-feedback.md` also use `gh run view <run-id> --log-failed` (GitHub-Actions log fetch) and `gh pr view --json mergeStateStatus`. The `forge` wrapper implements `pr view --json` (Task 8) but `run view --log-failed` has no portable Forgejo equivalent. In the templated text, gate that line on the forge: keep the `gh run view` hint only for GitHub, and for Forgejo replace it with "open the failed check's `link` from `{{forgeCli}} pr checks`". Implement this as two template fragments selected by `forgeCli`, not a runtime branch in the agent.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/constants/agentPrompts.test.ts server/services/promptRenderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
bash scripts/gate.sh
git add server/constants/agentPrompts.ts server/constants/prompts/pr.md server/constants/prompts/yolo.md server/constants/prompts/pr-feedback.md server/services/promptRenderer.ts server/services/agentRunner.ts server/constants/agentPrompts.test.ts
git commit -m "feat(forge): render gh/forge CLI per project in PR-agent prompts"
```

---

## Phase 5 — Inbound webhooks (Forgejo)

### Task 10: Forgejo signature validation + event normalization

**Files:**
- Modify: `server/services/webhookService.ts` (add `validateForgejoWebhookSignature`, `normalizeWebhookEvent`)
- Modify: `server/routes/webhooks.ts` (select validator/normalizer by header; map repo→project→connection)
- Test: `server/services/webhookService.test.ts`, `server/routes/webhooks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function validateForgejoWebhookSignature(payload: Buffer|string, signature: string|undefined, secret: string|undefined): boolean;
  export interface NormalizedWebhookEvent {
    kind: 'comment' | 'review'; prUrl?: string; prNumber?: number;
    branch?: string; bodyText?: string; comments?: ReviewCommentProvider[];
  }
  export function normalizeWebhookEvent(type: 'github'|'forgejo', headers: Record<string,unknown>, payload: Record<string,unknown>): NormalizedWebhookEvent | null;
  ```
  Forgejo signature: `HMAC-SHA256(rawBody, secret)` hex, compared to `X-Forgejo-Signature`/`X-Gitea-Signature` (no `sha256=` prefix), constant-time via `crypto.timingSafeEqual`. The route picks `validateForgejoWebhookSignature` when a Forgejo/Gitea header is present, else the existing GitHub validator.

- [ ] **Step 1: Write the failing tests**

```ts
// add to server/services/webhookService.test.ts
import crypto from 'crypto';
it('validates a Forgejo signature (hex, no prefix)', () => {
  const body = JSON.stringify({ a: 1 });
  const secret = 's';
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  expect(validateForgejoWebhookSignature(body, sig, secret)).toBe(true);
  expect(validateForgejoWebhookSignature(body, 'deadbeef', secret)).toBe(false);
});
it('normalizes a Forgejo issue_comment into a comment event', () => {
  const ev = normalizeWebhookEvent('forgejo', { 'x-gitea-event': 'issue_comment' }, {
    action: 'created',
    issue: { number: 4, pull_request: {}, html_url: 'https://git/o/r/pulls/4' },
    comment: { body: '@bottega fix it' },
  });
  expect(ev).toMatchObject({ kind: 'comment', prNumber: 4, bodyText: '@bottega fix it' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/webhookService.test.ts -t "Forgejo"`
Expected: FAIL — functions undefined.

- [ ] **Step 3: Implement** `validateForgejoWebhookSignature` and `normalizeWebhookEvent` (GitHub branch reproduces the current payload reads in `webhooks.ts`; Forgejo branch maps `issue.pull_request`+`comment.body` and `review`+`pull_request` shapes). Update the route to choose validator/normalizer by header and to look up the project's connection type by repo full-name.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/services/webhookService.test.ts server/routes/webhooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate + commit**

```bash
bash scripts/gate.sh
git add server/services/webhookService.ts server/routes/webhooks.ts server/services/webhookService.test.ts
git commit -m "feat(forge): Forgejo webhook signature + event normalization"
```

---

## Phase 6 — Admin & Settings UI (frontend)

> These tasks add UI over the Phase 2 backend. They are independently shippable after Phase 5; if you only run Bottega for yourself, you can seed `forge_connections` and tokens via the API and skip the UI. Follow existing component patterns in `src/components/Admin/*` and `src/components/` — do not invent new state/layout conventions.

### Task 11: Admin "Forge connections" routes + panel

**Files:**
- Create: `server/routes/forgeConnections.ts` (admin-guarded CRUD over `forgeConnectionsDb`)
- Create: `shared/schemas/forge.ts` (zod: `CreateForgeConnectionSchema`, `SetEnabledSchema`)
- Modify: `server/index.ts` (mount `/api/admin/forge-connections` behind the admin guard)
- Create: `src/components/Admin/ForgeConnections.tsx` + test
- Modify: the Admin page to add the panel/tab.

**Interfaces:**
- Consumes: `forgeConnectionsDb` (Task 4). Validate every handler with the zod schemas via `validateBody`/`validateParams` (Global Constraints).
- Produces: `GET/POST /api/admin/forge-connections`, `PATCH /api/admin/forge-connections/:id`, `DELETE /api/admin/forge-connections/:id`.

- [ ] **Step 1: Write the failing route test** (supertest, admin JWT) asserting `POST` creates and `GET` lists a connection; assert `403` for a non-admin token. Mirror an existing admin route test under `server/routes/`.
- [ ] **Step 2: Run it** — `pnpm vitest run server/routes/forgeConnections.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** schema, route, mount. Re-run — Expected: PASS.
- [ ] **Step 4: Build the `ForgeConnections.tsx` panel** (list + add form + enable toggle + delete), following an existing Admin component; add a component test that renders the list from a mocked fetch.
- [ ] **Step 5: Gate + commit**

```bash
bash scripts/gate.sh
git add server/routes/forgeConnections.ts shared/schemas/forge.ts server/index.ts src/components/Admin/ForgeConnections.tsx server/routes/forgeConnections.test.ts src/components/Admin/ForgeConnections.test.tsx
git commit -m "feat(forge): admin forge-connections API + panel"
```

### Task 12: Per-project forge selector + per-user "Connect forge"

**Files:**
- Modify: project create/edit form component under `src/components/` (add a **Forge** `<select>` populated from enabled connections; submit `forge_connection_id`)
- Modify: `server/routes/projects.ts` + `shared/schemas/projects.ts` (accept optional `forge_connection_id`)
- Create: per-user routes `server/routes/forgeTokens.ts` + `shared/schemas/forge.ts` additions (`SetForgeTokenSchema`) over `forgeCredentials.ts` (Task 5)
- Modify: Settings/Account UI to add a **Connect forge** section (pick connection, paste PAT, save/clear)
- Tests: route tests for both; a component test for the selector.

**Interfaces:**
- Consumes: `forgeConnectionsDb.listEnabled` (Task 4), `setForgeToken`/`deleteForgeToken` (Task 5).
- Produces: `PUT /api/projects/:id` accepts `forge_connection_id`; `POST /api/me/forge-tokens` `{ connectionId, token }`, `DELETE /api/me/forge-tokens/:connectionId`.

- [ ] **Step 1: Write failing route tests** — project update persists `forge_connection_id`; `POST /api/me/forge-tokens` stores a token retrievable by `getForgeToken` for the authed user. Run them — Expected: FAIL.
- [ ] **Step 2: Implement** schemas, routes, mounts. Re-run — Expected: PASS.
- [ ] **Step 3: Wire the project-form selector and the Settings "Connect forge" section**, following existing form components; add a component test rendering the selector from mocked enabled connections.
- [ ] **Step 4: Manual E2E (Playwright MCP)** per `reference/CLAUDE.md`: create a Forgejo connection in Admin, set it on a project, save a PAT in Settings, run a task end-to-end against a test Forgejo repo, confirm a PR opens and CI status is read. Record the result.
- [ ] **Step 5: Gate + commit**

```bash
bash scripts/gate.sh
git add -A
git commit -m "feat(forge): per-project forge selector and per-user token connect UI"
```

---

## Final verification

- [ ] Run the full gate from `reference/`: `bash scripts/gate.sh` → exit 0.
- [ ] Confirm a **pure-GitHub** project still opens PRs and reads CI unchanged (regression check — Phase 1 guaranteed parity; verify end-to-end).
- [ ] Confirm a **Forgejo** project opens a PR, the "keep CI green" loop reads commit statuses, the PR merges, and a `@`-mention webhook re-triggers the PR agent.
- [ ] Update `reference/docs/agentic-loop.md` (the "GitHub webhook callbacks" section) to mention forge selection, and note the Forgejo-CI-status deployment prerequisite from the spec.

## Notes on sequencing & risk

- **Phases 1–3 are backend-only and independently valuable.** After Phase 3 the providers exist and are tested; after Phase 5 the whole backend works against Forgejo via API. Phase 6 is just the configuration UI.
- **Highest-risk task is Task 7** (Forgejo API shapes vary by version). Validate `forgejoProvider` against a real Forgejo instance early — the unit tests mock `fetch`, so they prove mapping logic, not endpoint correctness.
- **`gh run view --log-failed` has no portable equivalent** (Task 9 note). The plan degrades it to "open the failing check link" for Forgejo rather than faking it.
