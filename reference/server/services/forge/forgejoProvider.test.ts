import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mockRunCommand so the vi.mock factory can reference it.
const { mockRunCommand } = vi.hoisted(() => ({
  mockRunCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('../shell.js', () => ({
  runCommand: mockRunCommand,
}));

import { forgejoProvider } from './forgejoProvider.js';
import type { ForgeContext } from './types.js';

const ctx: ForgeContext = {
  type: 'forgejo', baseUrl: 'https://git.example.com', owner: 'o', repo: 'r',
  token: 'pat', worktreePath: '/tmp/wt',
};
const json = (body: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  mockRunCommand.mockClear();
  mockRunCommand.mockResolvedValue({ stdout: '', stderr: '' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('forgejoProvider', () => {
  it('createPR pushes branch then reads default branch then POSTs a pull and returns html_url', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockReturnValueOnce(json({ default_branch: 'main' }))                               // GET repo
      .mockReturnValueOnce(json({ html_url: 'https://git.example.com/o/r/pulls/3', number: 3 })); // POST pulls
    const res = await forgejoProvider.createPR(ctx, { branch: 'task/3-x', title: 'T', body: 'B' });
    expect(res).toEqual({ url: 'https://git.example.com/o/r/pulls/3', number: 3 });
    // verify git push was performed before any fetch calls
    expect(mockRunCommand).toHaveBeenCalledWith(
      'git', ['push', '-u', 'origin', 'task/3-x'], { cwd: '/tmp/wt' },
    );
    const call = fetchMock.mock.calls[1]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit & { body: string; headers: Record<string, string> };
    expect(url).toBe('https://git.example.com/api/v1/repos/o/r/pulls');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ head: 'task/3-x', base: 'main', title: 'T', body: 'B' });
    expect(init.headers.Authorization).toBe('token pat');
  });

  it('getPRStatus maps a failing commit status to failed (status field)', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockReturnValueOnce(json([{ number: 3, head: { ref: 'task/3-x', sha: 'abc' }, html_url: 'u', state: 'open', mergeable: true }]))
      .mockReturnValueOnce(json({ state: 'failure', statuses: [{ context: 'ci', status: 'failure', target_url: 'l' }] }));
    const s = await forgejoProvider.getPRStatus(ctx, { branch: 'task/3-x' });
    expect(s.exists).toBe(true);
    expect(s.ciStatus?.status).toBe('failed');
    expect(s.ciStatus?.checks[0]?.state).toBe('failure');
    expect(s.ciStatus?.checks[0]?.bucket).toBe('fail');
  });

  it('getPRStatus maps a failing commit status to failed (state field — defensive read)', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockReturnValueOnce(json([{ number: 3, head: { ref: 'task/3-x', sha: 'abc' }, html_url: 'u', state: 'open', mergeable: true }]))
      .mockReturnValueOnce(json({ state: 'failure', statuses: [{ context: 'ci', state: 'failure', target_url: 'l' }] }));
    const s = await forgejoProvider.getPRStatus(ctx, { branch: 'task/3-x' });
    expect(s.exists).toBe(true);
    expect(s.ciStatus?.status).toBe('failed');
    expect(s.ciStatus?.checks[0]?.state).toBe('failure');
    expect(s.ciStatus?.checks[0]?.bucket).toBe('fail');
  });

  it('getPRStatus returns exists:false when no PR matches the branch', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReturnValueOnce(json([{ number: 1, head: { ref: 'other-branch', sha: 'xyz' }, html_url: 'u', state: 'open', mergeable: false }]));
    const s = await forgejoProvider.getPRStatus(ctx, { branch: 'task/3-x' });
    expect(s.exists).toBe(false);
  });

  it('getPRStatus maps mergeable boolean to CONFLICTING when false', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockReturnValueOnce(json([{ number: 5, head: { ref: 'feat/x', sha: 'def' }, html_url: 'u2', state: 'open', mergeable: false }]))
      .mockReturnValueOnce(json({ state: 'success', statuses: [] }));
    const s = await forgejoProvider.getPRStatus(ctx, { branch: 'feat/x' });
    expect(s.mergeable).toBe('CONFLICTING');
    expect(s.ciStatus?.status).toBe('passed');
  });

  it('mergePR POSTs body { Do: "merge" } to the merge endpoint', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReturnValueOnce(json({}));
    await forgejoProvider.mergePR(ctx, { prNumber: 7 });
    const call = fetchMock.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit & { body: string };
    expect(url).toBe('https://git.example.com/api/v1/repos/o/r/pulls/7/merge');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ Do: 'merge' });
  });

  it('throws on non-2xx response', async () => {
    vi.mocked(fetch).mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('Not Found') } as Response),
    );
    await expect(forgejoProvider.getPRBranch(ctx, { prNumber: 99, repoFullName: 'o/r' })).rejects.toThrow(
      'Forgejo GET /repos/o/r/pulls/99 failed: 404 Not Found',
    );
  });

  it('getPRBranch returns head.ref', async () => {
    vi.mocked(fetch).mockReturnValueOnce(json({ head: { ref: 'feat/branch' } }));
    const branch = await forgejoProvider.getPRBranch(ctx, { prNumber: 4, repoFullName: 'o/r' });
    expect(branch).toBe('feat/branch');
  });

  it('getReviewComments calls the correct endpoint and maps line ?? original_position fallback', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReturnValueOnce(json([
      { body: 'looks good', user: { login: 'alice' }, path: 'src/foo.ts', line: 10, original_position: 5, diff_hunk: '@@ -1,3 +1,4 @@' },
      { body: 'needs work', user: { login: 'bob' }, path: 'src/bar.ts', line: null, original_position: 7, diff_hunk: '@@ -2,2 +2,3 @@' },
    ]));
    const comments = await forgejoProvider.getReviewComments(ctx, { prNumber: 5, reviewId: 42, repoFullName: 'o/r' });

    const call = fetchMock.mock.calls[0]!;
    expect(call[0] as string).toBe('https://git.example.com/api/v1/repos/o/r/pulls/5/reviews/42/comments');
    expect((call[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe('token pat');

    expect(comments).toHaveLength(2);
    // first entry has line set — uses line directly
    expect(comments[0]).toMatchObject({ body: 'looks good', line: 10, path: 'src/foo.ts', diff_hunk: '@@ -1,3 +1,4 @@' });
    expect(comments[0]?.user).toEqual({ login: 'alice' });
    // second entry has line null — falls back to original_position
    expect(comments[1]).toMatchObject({ body: 'needs work', line: 7, path: 'src/bar.ts', diff_hunk: '@@ -2,2 +2,3 @@' });
  });
});
