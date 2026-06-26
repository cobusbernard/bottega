// Webhook Routes
//
// Handles incoming webhooks from external services like GitHub and Forgejo.
// GitHub webhooks trigger PR agent runs when the configured @-trigger
// (e.g. @bottega) is mentioned in PR comments. The trigger string is
// stored in app_settings.github_pr_trigger and editable from the UI.
//
// Forgejo webhooks work the same way, but issue_comment payloads lack the
// PR branch. A per-connection bot token (set by an admin via
// PUT /api/admin/forge-connections/:id/token) is used to call the Forgejo
// API and resolve the branch.

import express, { type Request, type Response } from 'express';
import {
  validateGitHubWebhookSignature,
  validateForgejoWebhookSignature,
  normalizeWebhookEvent,
  parseTaskIdFromBranch,
  hasTriggerMention,
  getConfiguredTrigger,
  triggerPrAgentFromComment,
  triggerPrAgentFromReview,
} from '../services/webhookService.js';
import {
  assertValidPositiveInt,
  assertValidRepoFullName,
  ValidationError,
} from '../services/validators.js';
import { githubProvider } from '../services/forge/githubProvider.js';
import { forgejoProvider } from '../services/forge/forgejoProvider.js';
import { forgeConnectionsDb } from '../database/db.js';
import { getConnectionToken } from '../services/connectionCredentials.js';
import type { ForgeConnectionRow } from '../../shared/types/db.js';
import type { ForgeContext } from '../services/forge/types.js';

const router = express.Router();

interface GitHubReviewComment {
  body?: string;
  user?: { login?: string };
  path?: string;
  line?: number | null;
  start_line?: number | null;
  diff_hunk?: string | null;
  side?: string | null;
}

async function fetchPrBranchName(
  prNumber: number,
  repoFullName: string,
): Promise<string | null> {
  try {
    assertValidPositiveInt(prNumber, 'PR number');
    assertValidRepoFullName(repoFullName);
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error('[Webhook] Rejected PR fetch:', error.message);
      return null;
    }
    throw error;
  }
  const ctx = { type: 'github' as const, baseUrl: 'https://github.com', owner: '', repo: '', token: null, worktreePath: '' };
  return githubProvider.getPRBranch(ctx, { prNumber, repoFullName });
}

async function fetchReviewComments(
  repoFullName: string,
  prNumber: number,
  reviewId: number,
): Promise<GitHubReviewComment[]> {
  try {
    assertValidRepoFullName(repoFullName);
    assertValidPositiveInt(prNumber, 'PR number');
    assertValidPositiveInt(reviewId, 'review ID');
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error('[Webhook] Rejected review-comments fetch:', error.message);
      return [];
    }
    throw error;
  }
  const ctx = { type: 'github' as const, baseUrl: 'https://github.com', owner: '', repo: '', token: null, worktreePath: '' };
  return githubProvider.getReviewComments(ctx, { prNumber, reviewId, repoFullName });
}

/**
 * Find a Forgejo forge_connection whose base_url host matches the given
 * repository URL host, and return the stored bot token. Returns null if no
 * match or no token is configured.
 */
function findForgejoConnectionToken(
  repoHtmlUrl: string | undefined,
): { connection: ForgeConnectionRow; token: string } | null {
  if (!repoHtmlUrl) return null;

  let repoHost: string;
  try {
    repoHost = new URL(repoHtmlUrl).host;
  } catch {
    return null;
  }

  const connections = forgeConnectionsDb.listEnabled();
  for (const conn of connections) {
    if (conn.type !== 'forgejo') continue;
    try {
      if (new URL(conn.base_url).host !== repoHost) continue;
    } catch {
      continue;
    }
    const token = getConnectionToken(conn.id);
    if (token) return { connection: conn, token };
  }
  return null;
}

router.post(
  '/github',
  async (req: Request, res: Response<unknown>) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    // ------------------------------------------------------------------ Forgejo / Gitea path
    // Select validator by which signature header is present. Forgejo and Gitea both
    // send the hex HMAC-SHA256 digest without a "sha256=" prefix. We reuse the same
    // webhook secret env var for both forge types.
    const forgejoSig = (req.headers['x-forgejo-signature'] ?? req.headers['x-gitea-signature']) as
      | string
      | undefined;

    if (forgejoSig) {
      if (!validateForgejoWebhookSignature(req.body, forgejoSig, secret)) {
        console.log('[Webhook] Invalid Forgejo signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      let forgejoPayload: Record<string, unknown>;
      try {
        forgejoPayload = JSON.parse((req.body as Buffer).toString()) as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Webhook] Failed to parse Forgejo payload:', message);
        return res.status(400).json({ error: 'Invalid JSON payload' });
      }

      const normalized = normalizeWebhookEvent(
        'forgejo',
        req.headers,
        forgejoPayload,
      );
      if (!normalized) {
        return res.status(200).json({ status: 'ignored', reason: 'event not relevant' });
      }

      const trigger = getConfiguredTrigger();

      if (normalized.kind === 'comment') {
        if (!hasTriggerMention(normalized.bodyText, trigger)) {
          return res
            .status(200)
            .json({ status: 'ignored', reason: `no @${trigger} mention` });
        }

        if (!normalized.prNumber) {
          return res.status(200).json({ status: 'ignored', reason: 'could not determine PR' });
        }

        // Resolve the PR branch via the Forgejo API using a per-connection bot token.
        const repoHtmlUrl = (forgejoPayload.repository as { html_url?: string } | undefined)?.html_url;
        const repoFullName = (forgejoPayload.repository as { full_name?: string } | undefined)?.full_name;
        const match = findForgejoConnectionToken(repoHtmlUrl);

        if (!match || !repoFullName) {
          console.log('[Webhook] Forgejo issue_comment: no connection bot token configured; ignoring');
          return res
            .status(200)
            .json({ status: 'ignored', reason: 'could not determine branch' });
        }

        const [owner = '', repo = ''] = repoFullName.split('/');
        const ctx: ForgeContext = {
          type: 'forgejo',
          baseUrl: match.connection.base_url,
          owner,
          repo,
          token: match.token,
          worktreePath: '',
        };

        let branchName: string | null;
        try {
          branchName = await forgejoProvider.getPRBranch(ctx, {
            prNumber: normalized.prNumber,
            repoFullName,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[Webhook] Forgejo getPRBranch failed:', message);
          return res.status(200).json({ status: 'ignored', reason: 'could not determine branch' });
        }

        if (!branchName) {
          console.log('[Webhook] Forgejo issue_comment: could not determine branch from API');
          return res.status(200).json({ status: 'ignored', reason: 'could not determine branch' });
        }

        const taskId = parseTaskIdFromBranch(branchName);
        if (!taskId) {
          console.log(`[Webhook] Forgejo branch ${branchName} does not match task pattern`);
          return res
            .status(200)
            .json({ status: 'ignored', reason: 'branch not in task format' });
        }

        const commentPayload = forgejoPayload.comment as
          | { body?: string; user?: { login?: string } }
          | undefined;
        const commentBody = normalized.bodyText || commentPayload?.body || '';
        const commentAuthor = commentPayload?.user?.login || 'unknown';

        try {
          const result = await triggerPrAgentFromComment({
            taskId,
            commentBody,
            commentAuthor,
            prUrl: normalized.prUrl,
            fileContext: null,
            broadcastToConversationSubscribers:
              req.app.locals.broadcastToConversationSubscribers,
            broadcastToTaskSubscribers: req.app.locals.broadcastToTaskSubscribers,
          });

          console.log(
            `[Webhook] Successfully triggered PR agent for task ${taskId} from Forgejo comment`,
          );
          return res.status(200).json({
            status: 'triggered',
            taskId,
            conversationId: result.conversationId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[Webhook] Failed to trigger PR agent from Forgejo comment:', message);

          if (
            message.includes('not found') ||
            message.includes('already completed') ||
            message.includes('No worktree') ||
            message.includes('already running')
          ) {
            return res.status(200).json({ status: 'ignored', reason: message });
          }

          return res.status(500).json({ error: 'Failed to trigger agent', message });
        }
      }

      if (normalized.kind === 'review') {
        const reviewBody = normalized.bodyText || '';
        const hasTrigger = hasTriggerMention(reviewBody, trigger) ||
          (normalized.comments?.some((c) => hasTriggerMention(c.body ?? '', trigger)) ?? false);

        if (!hasTrigger) {
          return res
            .status(200)
            .json({ status: 'ignored', reason: `no @${trigger} mention` });
        }

        const branchName = normalized.branch;
        if (!branchName) {
          console.log('[Webhook] Forgejo review: could not determine branch name');
          return res
            .status(200)
            .json({ status: 'ignored', reason: 'could not determine branch' });
        }

        const taskId = parseTaskIdFromBranch(branchName);
        if (!taskId) {
          console.log(`[Webhook] Forgejo branch ${branchName} does not match task pattern`);
          return res
            .status(200)
            .json({ status: 'ignored', reason: 'branch not in task format' });
        }

        const reviewPayload = forgejoPayload.review as
          | { id?: number; user?: { login?: string } }
          | undefined;
        const reviewAuthor = reviewPayload?.user?.login || 'unknown';
        const reviewId = reviewPayload?.id;

        // Attempt to fetch inline review comments via the bot token.
        let reviewComments: GitHubReviewComment[] = [];
        const repoHtmlUrl = (forgejoPayload.repository as { html_url?: string } | undefined)?.html_url;
        const repoFullName = (forgejoPayload.repository as { full_name?: string } | undefined)?.full_name;
        const match = findForgejoConnectionToken(repoHtmlUrl);

        if (match && repoFullName && reviewId && normalized.prNumber) {
          const [owner = '', repo = ''] = repoFullName.split('/');
          const ctx: ForgeContext = {
            type: 'forgejo',
            baseUrl: match.connection.base_url,
            owner,
            repo,
            token: match.token,
            worktreePath: '',
          };
          try {
            reviewComments = await forgejoProvider.getReviewComments(ctx, {
              prNumber: normalized.prNumber,
              reviewId,
              repoFullName,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[Webhook] Forgejo getReviewComments failed (continuing with empty):', message);
          }
        }

        try {
          const result = await triggerPrAgentFromReview({
            taskId,
            reviewBody: reviewBody || null,
            reviewAuthor,
            comments: reviewComments.map((c) => ({
              commentBody: c.body,
              commentAuthor: c.user?.login || 'unknown',
              fileContext: c.path
                ? {
                    path: c.path,
                    line: c.line || null,
                    startLine: c.start_line || null,
                    diffHunk: c.diff_hunk || null,
                    side: c.side || null,
                  }
                : null,
            })),
            prUrl: normalized.prUrl,
            broadcastToConversationSubscribers:
              req.app.locals.broadcastToConversationSubscribers,
            broadcastToTaskSubscribers: req.app.locals.broadcastToTaskSubscribers,
          });

          console.log(
            `[Webhook] Successfully triggered PR agent for task ${taskId} from Forgejo review`,
          );
          return res.status(200).json({
            status: 'triggered',
            taskId,
            conversationId: result.conversationId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[Webhook] Failed to trigger PR agent from Forgejo review:', message);

          if (
            message.includes('not found') ||
            message.includes('already completed') ||
            message.includes('No worktree') ||
            message.includes('already running')
          ) {
            return res.status(200).json({ status: 'ignored', reason: message });
          }

          return res.status(500).json({ error: 'Failed to trigger agent', message });
        }
      }

      return res.status(200).json({ status: 'ignored', reason: 'unknown event kind' });
    }

    // ------------------------------------------------------------------ GitHub path (unchanged)
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!validateGitHubWebhookSignature(req.body, signature, secret)) {
      console.log('[Webhook] Invalid GitHub signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse((req.body as Buffer).toString()) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Webhook] Failed to parse payload:', message);
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const eventType = req.headers['x-github-event'] as string | undefined;

    if (eventType !== 'issue_comment' && eventType !== 'pull_request_review') {
      return res.status(200).json({ status: 'ignored', event: eventType });
    }

    const expectedAction = eventType === 'pull_request_review' ? 'submitted' : 'created';
    if (payload.action !== expectedAction) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: `not a ${expectedAction} event` });
    }

    if (
      eventType === 'issue_comment' &&
      !(payload.issue as { pull_request?: unknown } | undefined)?.pull_request
    ) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'not a PR comment' });
    }

    const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name;

    if (eventType === 'pull_request_review') {
      const review = payload.review as
        | { body?: string; user?: { login?: string }; id?: number }
        | undefined;
      const pullRequest = payload.pull_request as
        | { number?: number; head?: { ref?: string }; html_url?: string }
        | undefined;
      const reviewBody = review?.body || '';
      const reviewAuthor = review?.user?.login || 'unknown';
      const reviewId = review?.id;
      const prNumber = pullRequest?.number;
      const branchName = pullRequest?.head?.ref;
      const prUrl = pullRequest?.html_url;

      let reviewComments: GitHubReviewComment[] = [];
      if (reviewId && prNumber && repoFullName !== undefined) {
        reviewComments = await fetchReviewComments(repoFullName, prNumber, reviewId);
      }

      const trigger = getConfiguredTrigger();
      const hasTriggerInBody = hasTriggerMention(reviewBody, trigger);
      const hasTriggerInComments = reviewComments.some((c) =>
        hasTriggerMention(c.body ?? '', trigger),
      );

      if (!hasTriggerInBody && !hasTriggerInComments) {
        return res
          .status(200)
          .json({ status: 'ignored', reason: `no @${trigger} mention` });
      }

      if (!branchName) {
        console.log('[Webhook] Could not determine branch name from review');
        return res
          .status(200)
          .json({ status: 'ignored', reason: 'could not determine branch' });
      }

      const taskId = parseTaskIdFromBranch(branchName);
      if (!taskId) {
        console.log(`[Webhook] Branch ${branchName} does not match task pattern`);
        return res
          .status(200)
          .json({ status: 'ignored', reason: 'branch not in task format' });
      }

      const comments = reviewComments.map((c) => ({
        commentBody: c.body,
        commentAuthor: c.user?.login || 'unknown',
        fileContext: c.path
          ? {
              path: c.path,
              line: c.line || null,
              startLine: c.start_line || null,
              diffHunk: c.diff_hunk || null,
              side: c.side || null,
            }
          : null,
      }));

      try {
        const result = await triggerPrAgentFromReview({
          taskId,
          reviewBody: reviewBody || null,
          reviewAuthor,
          comments,
          prUrl,
          broadcastToConversationSubscribers:
            req.app.locals.broadcastToConversationSubscribers,
          broadcastToTaskSubscribers: req.app.locals.broadcastToTaskSubscribers,
        });

        console.log(
          `[Webhook] Successfully triggered PR agent for task ${taskId} from review`,
        );
        return res.status(200).json({
          status: 'triggered',
          taskId,
          conversationId: result.conversationId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Webhook] Failed to trigger PR agent from review:', message);

        if (
          message.includes('not found') ||
          message.includes('already completed') ||
          message.includes('No worktree') ||
          message.includes('already running')
        ) {
          return res.status(200).json({
            status: 'ignored',
            reason: message,
          });
        }

        return res
          .status(500)
          .json({ error: 'Failed to trigger agent', message });
      }
    }

    const comment = payload.comment as
      | { body?: string; user?: { login?: string } }
      | undefined;
    const issue = payload.issue as
      | { number?: number; html_url?: string }
      | undefined;
    const commentBody = comment?.body || '';
    const issueTrigger = getConfiguredTrigger();
    if (!hasTriggerMention(commentBody, issueTrigger)) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: `no @${issueTrigger} mention` });
    }

    const prNumber = issue?.number;
    if (!prNumber || repoFullName === undefined) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'could not determine PR' });
    }
    const branchName = await fetchPrBranchName(prNumber, repoFullName);

    if (!branchName) {
      console.log('[Webhook] Could not determine branch name');
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'could not determine branch' });
    }

    const taskId = parseTaskIdFromBranch(branchName);
    if (!taskId) {
      console.log(`[Webhook] Branch ${branchName} does not match task pattern`);
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'branch not in task format' });
    }

    const prUrl = issue?.html_url;

    try {
      const result = await triggerPrAgentFromComment({
        taskId,
        commentBody,
        commentAuthor: comment?.user?.login || 'unknown',
        prUrl,
        fileContext: null,
        broadcastToConversationSubscribers:
          req.app.locals.broadcastToConversationSubscribers,
        broadcastToTaskSubscribers: req.app.locals.broadcastToTaskSubscribers,
      });

      console.log(`[Webhook] Successfully triggered PR agent for task ${taskId}`);
      res.status(200).json({
        status: 'triggered',
        taskId,
        conversationId: result.conversationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Webhook] Failed to trigger PR agent:', message);

      if (
        message.includes('not found') ||
        message.includes('already completed') ||
        message.includes('No worktree') ||
        message.includes('already running')
      ) {
        return res.status(200).json({
          status: 'ignored',
          reason: message,
        });
      }

      res.status(500).json({ error: 'Failed to trigger agent', message });
    }
  },
);

router.get('/health', (_req: Request, res: Response<unknown>) => {
  const hasSecret = !!process.env.GITHUB_WEBHOOK_SECRET;
  res.json({
    status: 'ok',
    webhookSecretConfigured: hasSecret,
  });
});

export default router;
