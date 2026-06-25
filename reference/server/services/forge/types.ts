import type { CICheck, CIStatus, PullRequestStatusResult } from '../worktree.js';

export type { CICheck, CIStatus, PullRequestStatusResult };

export interface ForgeContext {
  type: 'github' | 'forgejo';
  baseUrl: string;        // 'https://github.com' or e.g. 'https://git.example.com'
  owner: string;
  repo: string;
  token: string | null;   // acting user's token; null => provider falls back to ambient gh auth
  worktreePath: string;    // cwd for git/gh operations
}

export interface CreatePRArgs {
  branch: string;
  title: string;
  body: string;
}

export interface CreatePRResultProvider {
  url: string;
  number: number | null;
}

export interface ReviewCommentProvider {
  body?: string;
  user?: { login?: string };
  path?: string;
  line?: number | null;
  start_line?: number | null;
  diff_hunk?: string | null;
  side?: string | null;
}

export interface ForgeProvider {
  createPR(ctx: ForgeContext, args: CreatePRArgs): Promise<CreatePRResultProvider>;
  getPRStatus(ctx: ForgeContext, args: { branch: string | null }): Promise<PullRequestStatusResult>;
  mergePR(ctx: ForgeContext, args: { prNumber: number }): Promise<void>;
  getPRBranch(ctx: ForgeContext, args: { prNumber: number; repoFullName: string }): Promise<string | null>;
  getReviewComments(ctx: ForgeContext, args: { prNumber: number; reviewId: number; repoFullName: string }): Promise<ReviewCommentProvider[]>;
}
