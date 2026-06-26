/**
 * Webhook Service
 *
 * Handles GitHub and Forgejo webhook signature validation, event normalization,
 * task identification, and PR agent triggering for @-mentions in PR comments.
 * The trigger string itself is read from app_settings (configurable per instance).
 */

import crypto from 'crypto';
import { tasksDb, userDb, agentRunsDb, appSettingsDb } from '../database/db.js';
import { worktreeExists } from './worktree.js';
import type { ReviewCommentProvider } from './forge/types.js';
import type {
  BroadcastFn,
  BroadcastToConversationSubscribersFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';

/**
 * Validate GitHub webhook signature using HMAC-SHA256
 */
export function validateGitHubWebhookSignature(
  payload: Buffer | string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const payloadString = typeof payload === 'string' ? payload : payload.toString();
  const expectedSignature =
    'sha256=' + crypto.createHmac('sha256', secret).update(payloadString, 'utf8').digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

/**
 * Validate Forgejo/Gitea webhook signature using HMAC-SHA256 (hex, no prefix).
 * Forgejo sends the raw hex digest in X-Forgejo-Signature / X-Gitea-Signature —
 * there is no "sha256=" prefix (unlike GitHub). Comparison is constant-time.
 */
export function validateForgejoWebhookSignature(
  payload: Buffer | string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const payloadString = typeof payload === 'string' ? payload : payload.toString();
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payloadString, 'utf8')
    .digest('hex');

  try {
    if (signature.length !== expectedSignature.length) {
      // timingSafeEqual requires equal-length buffers; guard to avoid throwing.
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

/**
 * Normalized webhook event — common shape for both GitHub and Forgejo deliveries.
 * Feeds directly into triggerPrAgentFromComment / triggerPrAgentFromReview.
 */
export interface NormalizedWebhookEvent {
  kind: 'comment' | 'review';
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  bodyText?: string;
  comments?: ReviewCommentProvider[];
}

/**
 * Normalize an inbound webhook payload into NormalizedWebhookEvent.
 *
 * GitHub branch: reads issue_comment and pull_request_review shapes.
 * Forgejo branch: maps Forgejo/Gitea issue_comment (issue.pull_request present)
 * and pull_request_review/review events to the same shape.
 *
 * Returns null for irrelevant events (wrong event type, wrong action, non-PR comment).
 */
export function normalizeWebhookEvent(
  type: 'github' | 'forgejo',
  headers: Record<string, unknown>,
  payload: Record<string, unknown>,
): NormalizedWebhookEvent | null {
  if (type === 'github') {
    const eventType = headers['x-github-event'] as string | undefined;

    if (eventType === 'issue_comment') {
      if (payload.action !== 'created') return null;
      const issue = payload.issue as
        | { number?: number; pull_request?: unknown; html_url?: string }
        | undefined;
      if (!issue?.pull_request) return null;
      const comment = payload.comment as { body?: string } | undefined;
      const ev: NormalizedWebhookEvent = { kind: 'comment' };
      if (issue.number !== undefined) ev.prNumber = issue.number;
      if (issue.html_url !== undefined) ev.prUrl = issue.html_url;
      if (comment?.body !== undefined) ev.bodyText = comment.body;
      return ev;
    }

    if (eventType === 'pull_request_review') {
      if (payload.action !== 'submitted') return null;
      const review = payload.review as
        | { body?: string; user?: { login?: string }; id?: number }
        | undefined;
      const pr = payload.pull_request as
        | { number?: number; head?: { ref?: string }; html_url?: string }
        | undefined;
      const ev: NormalizedWebhookEvent = { kind: 'review' };
      if (pr?.number !== undefined) ev.prNumber = pr.number;
      if (pr?.html_url !== undefined) ev.prUrl = pr.html_url;
      if (pr?.head?.ref !== undefined) ev.branch = pr.head.ref;
      if (review?.body !== undefined) ev.bodyText = review.body;
      return ev;
    }

    return null;
  }

  // Forgejo/Gitea — event type lives in x-gitea-event (Forgejo preserves the Gitea header name).
  const eventType = (headers['x-gitea-event'] ?? headers['x-forgejo-event']) as
    | string
    | undefined;

  if (eventType === 'issue_comment') {
    if (payload.action !== 'created') return null;
    const issue = payload.issue as
      | { number?: number; pull_request?: unknown; html_url?: string }
      | undefined;
    // Only trigger on PR comments — plain issues have no pull_request field.
    if (!issue?.pull_request) return null;
    const comment = payload.comment as { body?: string } | undefined;
    const ev: NormalizedWebhookEvent = { kind: 'comment' };
    if (issue.number !== undefined) ev.prNumber = issue.number;
    if (issue.html_url !== undefined) ev.prUrl = issue.html_url;
    if (comment?.body !== undefined) ev.bodyText = comment.body;
    // branch is NOT present in Forgejo issue_comment payloads; the caller must
    // fetch it via the Forgejo API using prNumber (pending forge-provider support).
    return ev;
  }

  if (eventType === 'pull_request_review' || eventType === 'review') {
    if (payload.action !== 'submitted') return null;
    const review = payload.review as
      | { body?: string; user?: { login?: string }; id?: number }
      | undefined;
    const pr = payload.pull_request as
      | { number?: number; head?: { ref?: string }; html_url?: string }
      | undefined;
    const ev: NormalizedWebhookEvent = { kind: 'review' };
    if (pr?.number !== undefined) ev.prNumber = pr.number;
    if (pr?.html_url !== undefined) ev.prUrl = pr.html_url;
    if (pr?.head?.ref !== undefined) ev.branch = pr.head.ref;
    if (review?.body !== undefined) ev.bodyText = review.body;
    return ev;
  }

  return null;
}

/**
 * Parse task ID from branch name
 * Expected format: task/{id}-{slug}
 */
export function parseTaskIdFromBranch(branchName: string | null | undefined): number | null {
  if (!branchName) return null;
  const match = branchName.match(/^task\/(\d+)-/);
  if (match?.[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Resolve the configured GitHub PR @-trigger from app_settings.
 * Falls back to the default ("bottega") if the table is unavailable.
 */
export function getConfiguredTrigger(): string {
  try {
    return appSettingsDb.getValue('github_pr_trigger') || 'bottega';
  } catch {
    return 'bottega';
  }
}

/**
 * Check if the configured @-trigger (e.g. "@bottega") is mentioned in
 * the comment (case-insensitive).
 */
export function hasTriggerMention(commentBody: string | null | undefined, trigger?: string): boolean {
  if (!commentBody) return false;
  const t = (trigger ?? getConfiguredTrigger()).toLowerCase();
  if (!t) return false;
  return commentBody.toLowerCase().includes('@' + t);
}

/**
 * Wrap the dispatch-owned per-conversation broadcast helper as the
 * `BroadcastFn(conversationId, message)` shape that the conversation
 * lifecycle expects. Webhook-triggered streams fan out to whoever is
 * subscribed to the conversation, exactly like manual streams.
 */
function createBroadcastFn(
  broadcastToConversationSubscribers:
    | BroadcastToConversationSubscribersFn
    | null
    | undefined,
): BroadcastFn | null {
  if (!broadcastToConversationSubscribers) return null;
  return (convId, msg) => broadcastToConversationSubscribers(convId, msg);
}

export interface FileContext {
  path: string;
  line?: number | null | undefined;
  startLine?: number | null | undefined;
  diffHunk?: string | null | undefined;
  side?: string | null | undefined;
}

export interface TriggerFromCommentArgs {
  taskId: number;
  commentBody: string;
  commentAuthor: string;
  prUrl?: string | undefined;
  fileContext: FileContext | null;
  broadcastToConversationSubscribers?: BroadcastToConversationSubscribersFn | undefined;
  broadcastToTaskSubscribers?: BroadcastToTaskSubscribersFn | undefined;
}

export interface TriggerResult {
  conversationId: number;
  agentRunId: number;
}

/**
 * Trigger PR agent from a GitHub PR comment
 */
export async function triggerPrAgentFromComment({
  taskId,
  commentBody,
  commentAuthor,
  prUrl,
  fileContext,
  broadcastToConversationSubscribers,
  broadcastToTaskSubscribers,
}: TriggerFromCommentArgs): Promise<TriggerResult> {
  // 1. Verify task exists
  const task = tasksDb.getById(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 2. Check task status - don't run for completed tasks
  if (task.status === 'completed') {
    throw new Error(`Task ${taskId} is already completed`);
  }

  // 3. Get task with project info for worktree check
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} project not found`);
  }

  // 4. Verify worktree exists
  const hasWorktree = await worktreeExists(taskWithProject.repo_folder_path, taskId);
  if (!hasWorktree) {
    throw new Error(`No worktree found for task ${taskId}`);
  }

  // 5. Check for already running PR agent (concurrency guard)
  const agentRuns = agentRunsDb.getByTask(taskId);
  const runningPrAgent = agentRuns.find((r) => r.agent_type === 'pr' && r.status === 'running');
  if (runningPrAgent) {
    throw new Error(`PR agent already running for task ${taskId}`);
  }

  // 6. Resolve the user to run the agent as (the task owner)
  if (!taskWithProject.user_id) {
    throw new Error(`Task ${taskId} has no owning user`);
  }
  const taskOwner = userDb.getUserById(taskWithProject.user_id);
  if (!taskOwner) {
    throw new Error(`Task ${taskId} owner (user ${taskWithProject.user_id}) not found or inactive`);
  }

  // 7. Create per-conversation broadcast function
  const broadcastFn = createBroadcastFn(broadcastToConversationSubscribers);

  // 8. Import and start PR agent with comment context
  // Dynamic import to avoid circular dependencies
  const { startAgentRun } = await import('./agentRunner.js');

  const { agentRun, conversation } = await startAgentRun(taskId, 'pr', {
    broadcastFn: broadcastFn ?? undefined,
    broadcastToTaskSubscribersFn: broadcastToTaskSubscribers,
    userId: taskOwner.id,
    // Custom context for comment-triggered PR agent
    webhookContext: {
      commentBody,
      commentAuthor,
      prUrl,
      fileContext,
      triggeredBy: 'github_webhook',
    },
  });

  console.log(`[Webhook] Triggered PR agent for task ${taskId}, conversation ${conversation.id}`);

  return {
    conversationId: conversation.id,
    agentRunId: agentRun.id,
  };
}

export interface ReviewComment {
  commentBody: string | undefined;
  commentAuthor: string;
  fileContext: FileContext | null;
}

export interface TriggerFromReviewArgs {
  taskId: number;
  reviewBody: string | null;
  reviewAuthor: string;
  comments: ReviewComment[];
  prUrl?: string | undefined;
  broadcastToConversationSubscribers?: BroadcastToConversationSubscribersFn | undefined;
  broadcastToTaskSubscribers?: BroadcastToTaskSubscribersFn | undefined;
}

/**
 * Trigger PR agent from a GitHub pull request review
 */
export async function triggerPrAgentFromReview({
  taskId,
  reviewBody,
  reviewAuthor,
  comments,
  prUrl,
  broadcastToConversationSubscribers,
  broadcastToTaskSubscribers,
}: TriggerFromReviewArgs): Promise<TriggerResult> {
  // 1. Verify task exists
  const task = tasksDb.getById(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 2. Check task status - don't run for completed tasks
  if (task.status === 'completed') {
    throw new Error(`Task ${taskId} is already completed`);
  }

  // 3. Get task with project info for worktree check
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} project not found`);
  }

  // 4. Verify worktree exists
  const hasWorktree = await worktreeExists(taskWithProject.repo_folder_path, taskId);
  if (!hasWorktree) {
    throw new Error(`No worktree found for task ${taskId}`);
  }

  // 5. Check for already running PR agent (concurrency guard)
  const agentRuns = agentRunsDb.getByTask(taskId);
  const runningPrAgent = agentRuns.find((r) => r.agent_type === 'pr' && r.status === 'running');
  if (runningPrAgent) {
    throw new Error(`PR agent already running for task ${taskId}`);
  }

  // 6. Resolve the user to run the agent as (the task owner)
  if (!taskWithProject.user_id) {
    throw new Error(`Task ${taskId} has no owning user`);
  }
  const taskOwner = userDb.getUserById(taskWithProject.user_id);
  if (!taskOwner) {
    throw new Error(`Task ${taskId} owner (user ${taskWithProject.user_id}) not found or inactive`);
  }

  // 7. Create per-conversation broadcast function
  const broadcastFn = createBroadcastFn(broadcastToConversationSubscribers);

  // 8. Import and start PR agent with review context
  const { startAgentRun } = await import('./agentRunner.js');

  const { agentRun, conversation } = await startAgentRun(taskId, 'pr', {
    broadcastFn: broadcastFn ?? undefined,
    broadcastToTaskSubscribersFn: broadcastToTaskSubscribers,
    userId: taskOwner.id,
    webhookContext: {
      reviewBody,
      reviewAuthor,
      comments,
      prUrl,
      triggeredBy: 'github_webhook',
    },
  });

  console.log(
    `[Webhook] Triggered PR agent from review for task ${taskId}, conversation ${conversation.id}`,
  );

  return {
    conversationId: conversation.id,
    agentRunId: agentRun.id,
  };
}
