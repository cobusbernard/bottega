import type {
  ForgeProvider,
  ForgeContext,
  CreatePRArgs,
  CreatePRResultProvider,
  ReviewCommentProvider,
} from './types.js';
import type { CICheck, CIStatus, PullRequestStatusResult } from '../worktree.js';

async function api(
  ctx: ForgeContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${ctx.baseUrl}/api/v1${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `token ${ctx.token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Forgejo ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function mapCiState(state: string): CIStatus['status'] {
  if (state === 'success') return 'passed';
  if (state === 'pending') return 'pending';
  if (state === 'failure' || state === 'error') return 'failed';
  return 'unknown';
}

export const forgejoProvider: ForgeProvider = {
  async createPR(ctx: ForgeContext, args: CreatePRArgs): Promise<CreatePRResultProvider> {
    const repoData = (await api(ctx, 'GET', `/repos/${ctx.owner}/${ctx.repo}`)) as {
      default_branch: string;
    };
    const pullData = (await api(ctx, 'POST', `/repos/${ctx.owner}/${ctx.repo}/pulls`, {
      head: args.branch,
      base: repoData.default_branch,
      title: args.title,
      body: args.body,
    })) as { html_url: string; number: number };
    return { url: pullData.html_url, number: pullData.number };
  },

  async getPRStatus(
    ctx: ForgeContext,
    args: { branch: string | null },
  ): Promise<PullRequestStatusResult> {
    const pulls = (await api(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/pulls?state=open`,
    )) as Array<{
      number: number;
      head: { ref: string; sha: string };
      html_url: string;
      state: string;
      mergeable: boolean;
    }>;

    const pr = pulls.find((p) => p.head.ref === args.branch);
    if (!pr) {
      return { success: true, exists: false };
    }

    const statusData = (await api(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/commits/${pr.head.sha}/status`,
    )) as {
      state: string;
      statuses: Array<{ context: string; status: string; target_url: string }>;
    };

    const checks: CICheck[] = statusData.statuses.map((s) => ({
      bucket: s.status === 'success' ? 'pass' : s.status === 'pending' ? 'pending' : 'fail',
      name: s.context,
      state: s.status,
      link: s.target_url,
    }));

    const ciStatus: CIStatus = {
      status: mapCiState(statusData.state),
      checks,
    };

    return {
      success: true,
      exists: true,
      url: pr.html_url,
      state: pr.state,
      mergeable: pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
      ciStatus,
    };
  },

  async mergePR(ctx: ForgeContext, args: { prNumber: number }): Promise<void> {
    await api(
      ctx,
      'POST',
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${args.prNumber}/merge`,
      { Do: 'merge' },
    );
  },

  async getPRBranch(
    ctx: ForgeContext,
    args: { prNumber: number; repoFullName: string },
  ): Promise<string | null> {
    const pr = (await api(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${args.prNumber}`,
    )) as { head: { ref: string } };
    return pr.head.ref ?? null;
  },

  async getReviewComments(
    ctx: ForgeContext,
    args: { prNumber: number; reviewId: number; repoFullName: string },
  ): Promise<ReviewCommentProvider[]> {
    const comments = (await api(
      ctx,
      'GET',
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${args.prNumber}/reviews/${args.reviewId}/comments`,
    )) as Array<{
      body?: string;
      user?: { login?: string };
      path?: string;
      original_position?: number | null;
      line?: number | null;
      diff_hunk?: string | null;
    }>;

    return comments.map((c): ReviewCommentProvider => {
      const comment: ReviewCommentProvider = {
        line: c.line ?? c.original_position ?? null,
        diff_hunk: c.diff_hunk ?? null,
      };
      if (c.body !== undefined) comment.body = c.body;
      if (c.user !== undefined) comment.user = c.user;
      if (c.path !== undefined) comment.path = c.path;
      return comment;
    });
  },
};
