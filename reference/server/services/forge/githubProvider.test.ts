import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../shell.js');
import { githubProvider } from './githubProvider.js';
import { runCommand } from '../shell.js';
import type { ForgeContext } from './types.js';

const mockRunCommand = vi.mocked(runCommand);

const ctx: ForgeContext = {
  type: 'github', baseUrl: 'https://github.com', owner: 'o', repo: 'r',
  token: null, worktreePath: '/tmp/wt',
};

beforeEach(() => mockRunCommand.mockReset());

describe('githubProvider', () => {
  it('createPR pushes then runs gh pr create and returns the url', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                              // git push
      .mockResolvedValueOnce({ stdout: 'https://github.com/o/r/pull/7\n', stderr: '' }); // gh pr create
    const res = await githubProvider.createPR(ctx, { branch: 'task/7-x', title: 'T', body: 'B' });
    expect(res.url).toBe('https://github.com/o/r/pull/7');
    expect(mockRunCommand).toHaveBeenNthCalledWith(1, 'git', ['push', '-u', 'origin', 'task/7-x'], { cwd: '/tmp/wt' });
    expect(mockRunCommand).toHaveBeenNthCalledWith(2, 'gh', ['pr', 'create', '--title', 'T', '--body', 'B'], { cwd: '/tmp/wt' });
  });

  it('getReviewComments calls gh api with the reviews path', async () => {
    mockRunCommand.mockResolvedValueOnce({ stdout: '[]', stderr: '' });
    const out = await githubProvider.getReviewComments(ctx, { prNumber: 42, reviewId: 9, repoFullName: 'o/r' });
    expect(out).toEqual([]);
    expect(mockRunCommand).toHaveBeenCalledWith('gh', ['api', 'repos/o/r/pulls/42/reviews/9/comments']);
  });
});
