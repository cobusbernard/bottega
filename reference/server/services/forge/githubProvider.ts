import { runCommand } from '../shell.js';
import type {
  ForgeProvider,
  ForgeContext,
  CreatePRArgs,
  CreatePRResultProvider,
  ReviewCommentProvider,
} from './types.js';
import type {
  CICheck,
  CIStatus,
  PullRequestStatusResult,
} from '../worktree.js';

export const githubProvider: ForgeProvider = {
  async createPR(
    ctx: ForgeContext,
    args: CreatePRArgs,
  ): Promise<CreatePRResultProvider> {
    const { branch, title, body } = args;

    await runCommand('git', ['push', '-u', 'origin', branch], {
      cwd: ctx.worktreePath,
    });

    const { stdout } = await runCommand(
      'gh',
      ['pr', 'create', '--title', title, '--body', body],
      { cwd: ctx.worktreePath },
    );

    return { url: stdout.trim(), number: null };
  },

  async getPRStatus(
    ctx: ForgeContext,
    _args: { branch: string | null },
  ): Promise<PullRequestStatusResult> {
    try {
      const { stdout } = await runCommand(
        'gh',
        ['pr', 'view', '--json', 'url,state,mergeable'],
        { cwd: ctx.worktreePath },
      );
      const prData = JSON.parse(stdout) as {
        url: string;
        state: string;
        mergeable: string;
      };

      let ciStatus: CIStatus = { status: 'none', checks: [] };
      try {
        const { stdout: checksOutput } = await runCommand(
          'gh',
          ['pr', 'checks', '--json', 'bucket,name,state,link'],
          { cwd: ctx.worktreePath },
        );
        const checks = JSON.parse(checksOutput) as CICheck[];

        if (checks.length > 0) {
          const hasFailed = checks.some((c) => c.bucket === 'fail');
          const hasPending = checks.some((c) => c.bucket === 'pending');
          const allPassed = checks.every(
            (c) => c.bucket === 'pass' || c.bucket === 'skipping',
          );

          if (hasFailed) {
            ciStatus = { status: 'failed', checks };
          } else if (hasPending) {
            ciStatus = { status: 'pending', checks };
          } else if (allPassed) {
            ciStatus = { status: 'passed', checks };
          } else {
            ciStatus = { status: 'unknown', checks };
          }
        }
      } catch (checksError) {
        const code = (checksError as { code?: number }).code;
        if (code === 8) {
          ciStatus = { status: 'pending', checks: [] };
        }
      }

      return {
        success: true,
        exists: true,
        url: prData.url,
        state: prData.state,
        mergeable: prData.mergeable,
        ciStatus,
      };
    } catch {
      return { success: true, exists: false };
    }
  },

  async mergePR(
    ctx: ForgeContext,
    _args: { prNumber: number },
  ): Promise<void> {
    await runCommand('gh', ['pr', 'merge', '--merge'], {
      cwd: ctx.worktreePath,
    });
  },

  async getPRBranch(
    ctx: ForgeContext,
    args: { prNumber: number; repoFullName: string },
  ): Promise<string | null> {
    try {
      const { stdout } = await runCommand('gh', [
        'pr',
        'view',
        String(args.prNumber),
        '--repo',
        args.repoFullName,
        '--json',
        'headRefName',
        '--jq',
        '.headRefName',
      ]);
      return stdout.trim() || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[GitHubProvider] Failed to fetch PR branch:', message);
      return null;
    }
  },

  async getReviewComments(
    ctx: ForgeContext,
    args: { prNumber: number; reviewId: number; repoFullName: string },
  ): Promise<ReviewCommentProvider[]> {
    try {
      const { stdout } = await runCommand('gh', [
        'api',
        `repos/${args.repoFullName}/pulls/${args.prNumber}/reviews/${args.reviewId}/comments`,
      ]);
      return JSON.parse(stdout) as ReviewCommentProvider[];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[GitHubProvider] Failed to fetch review comments:', message);
      return [];
    }
  },
};
