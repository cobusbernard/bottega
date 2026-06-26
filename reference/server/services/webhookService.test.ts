import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// Use vi.hoisted to create mock functions
const {
  mockGetById,
  mockGetWithProject,
  mockGetByTask,
  mockGetUserById,
  mockWorktreeExists,
  mockStartAgentRun,
  mockGetAppSetting
} = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockGetWithProject: vi.fn(),
  mockGetByTask: vi.fn(),
  mockGetUserById: vi.fn(),
  mockWorktreeExists: vi.fn(),
  mockStartAgentRun: vi.fn(),
  mockGetAppSetting: vi.fn()
}));

// Mock database
vi.mock('../database/db.js', () => ({
  tasksDb: {
    getById: mockGetById,
    getWithProject: mockGetWithProject
  },
  userDb: {
    getUserById: mockGetUserById
  },
  agentRunsDb: {
    getByTask: mockGetByTask
  },
  appSettingsDb: {
    getValue: mockGetAppSetting
  }
}));

// Mock worktree service
vi.mock('./worktree.js', () => ({
  worktreeExists: mockWorktreeExists
}));

// Mock agentRunner (dynamic import)
vi.mock('./agentRunner.js', () => ({
  startAgentRun: mockStartAgentRun
}));

import {
  validateGitHubWebhookSignature,
  validateForgejoWebhookSignature,
  normalizeWebhookEvent,
  parseTaskIdFromBranch,
  hasTriggerMention,
  getConfiguredTrigger,
  triggerPrAgentFromComment,
  triggerPrAgentFromReview
} from './webhookService.js';

describe('Webhook Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default trigger lookup so trigger-aware code paths see a stable value.
    vi.mocked(mockGetAppSetting).mockReturnValue('bottega');
  });

  describe('validateGitHubWebhookSignature', () => {
    const secret = 'test-secret-123';

    it('should return true for valid signature', () => {
      const payload = '{"test": "data"}';
      const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(payload, 'utf8')
        .digest('hex');

      const result = validateGitHubWebhookSignature(payload, expectedSignature, secret);
      expect(result).toBe(true);
    });

    it('should return false for invalid signature', () => {
      const payload = '{"test": "data"}';
      const invalidSignature = 'sha256=invalid-signature-here';

      const result = validateGitHubWebhookSignature(payload, invalidSignature, secret);
      expect(result).toBe(false);
    });

    it('should return false for missing signature', () => {
      const payload = '{"test": "data"}';

      const result = validateGitHubWebhookSignature(payload, null as never, secret);
      expect(result).toBe(false);
    });

    it('should return false for missing secret', () => {
      const payload = '{"test": "data"}';
      const signature = 'sha256=some-signature';

      const result = validateGitHubWebhookSignature(payload, signature, null as never);
      expect(result).toBe(false);
    });

    it('should handle Buffer payload', () => {
      const payload = Buffer.from('{"test": "data"}');
      const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(payload.toString(), 'utf8')
        .digest('hex');

      const result = validateGitHubWebhookSignature(payload, expectedSignature, secret);
      expect(result).toBe(true);
    });
  });

  describe('validateForgejoWebhookSignature', () => {
    it('validates a Forgejo signature (hex, no prefix)', () => {
      const body = JSON.stringify({ a: 1 });
      const secret = 's';
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
      expect(validateForgejoWebhookSignature(body, sig, secret)).toBe(true);
      expect(validateForgejoWebhookSignature(body, 'deadbeef', secret)).toBe(false);
    });

    it('returns false for a sha256= prefixed signature (GitHub-style)', () => {
      const body = '{"test": "data"}';
      const secret = 'test-secret';
      const rawHex = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
      const githubStyle = 'sha256=' + rawHex;
      // Forgejo expects raw hex; the sha256= prefix makes it a different string
      expect(validateForgejoWebhookSignature(body, githubStyle, secret)).toBe(false);
    });

    it('returns false for missing signature', () => {
      expect(validateForgejoWebhookSignature('body', undefined, 'secret')).toBe(false);
    });

    it('returns false for missing secret', () => {
      expect(validateForgejoWebhookSignature('body', 'sig', undefined)).toBe(false);
    });

    it('handles Buffer payload', () => {
      const body = Buffer.from('{"test": "data"}');
      const secret = 'buf-secret';
      const sig = crypto
        .createHmac('sha256', secret)
        .update(body.toString(), 'utf8')
        .digest('hex');
      expect(validateForgejoWebhookSignature(body, sig, secret)).toBe(true);
    });
  });

  describe('normalizeWebhookEvent — Forgejo', () => {
    it('normalizes a Forgejo issue_comment into a comment event', () => {
      const ev = normalizeWebhookEvent('forgejo', { 'x-gitea-event': 'issue_comment' }, {
        action: 'created',
        issue: { number: 4, pull_request: {}, html_url: 'https://git/o/r/pulls/4' },
        comment: { body: '@bottega fix it' },
      });
      expect(ev).toMatchObject({ kind: 'comment', prNumber: 4, bodyText: '@bottega fix it' });
    });

    it('returns null for Forgejo issue_comment on a plain issue (no pull_request)', () => {
      const ev = normalizeWebhookEvent('forgejo', { 'x-gitea-event': 'issue_comment' }, {
        action: 'created',
        issue: { number: 7, html_url: 'https://git/o/r/issues/7' },
        comment: { body: 'some comment' },
      });
      expect(ev).toBeNull();
    });

    it('returns null for Forgejo issue_comment with non-created action', () => {
      const ev = normalizeWebhookEvent('forgejo', { 'x-gitea-event': 'issue_comment' }, {
        action: 'edited',
        issue: { number: 4, pull_request: {}, html_url: 'https://git/o/r/pulls/4' },
        comment: { body: '@bottega fix it' },
      });
      expect(ev).toBeNull();
    });

    it('normalizes a Forgejo pull_request_review into a review event', () => {
      const ev = normalizeWebhookEvent('forgejo', { 'x-gitea-event': 'pull_request_review' }, {
        action: 'submitted',
        review: { id: 99, body: '@bottega lgtm', user: { login: 'reviewer' } },
        pull_request: {
          number: 10,
          head: { ref: 'task/10-my-feature' },
          html_url: 'https://git/o/r/pulls/10',
        },
      });
      expect(ev).toMatchObject({
        kind: 'review',
        prNumber: 10,
        branch: 'task/10-my-feature',
        bodyText: '@bottega lgtm',
      });
    });

    it('normalizes a Forgejo review (x-gitea-event: review) into a review event', () => {
      const ev = normalizeWebhookEvent('forgejo', { 'x-gitea-event': 'review' }, {
        action: 'submitted',
        review: { id: 100, body: '@bottega check this', user: { login: 'someone' } },
        pull_request: { number: 5, head: { ref: 'task/5-fix' }, html_url: 'https://git/o/r/pulls/5' },
      });
      expect(ev).toMatchObject({ kind: 'review', prNumber: 5, branch: 'task/5-fix' });
    });

    it('returns null for unrecognized Forgejo event types', () => {
      const ev = normalizeWebhookEvent('forgejo', { 'x-gitea-event': 'push' }, {
        action: 'created',
        ref: 'refs/heads/main',
      });
      expect(ev).toBeNull();
    });
  });

  describe('normalizeWebhookEvent — GitHub', () => {
    it('normalizes a GitHub issue_comment into a comment event', () => {
      const ev = normalizeWebhookEvent('github', { 'x-github-event': 'issue_comment' }, {
        action: 'created',
        issue: { number: 42, pull_request: { url: 'https://api.github.com/pulls/42' }, html_url: 'https://github.com/o/r/pull/42' },
        comment: { body: '@bottega fix this' },
      });
      expect(ev).toMatchObject({ kind: 'comment', prNumber: 42, bodyText: '@bottega fix this' });
    });

    it('normalizes a GitHub pull_request_review into a review event', () => {
      const ev = normalizeWebhookEvent('github', { 'x-github-event': 'pull_request_review' }, {
        action: 'submitted',
        review: { id: 55, body: 'looks good', user: { login: 'rev' } },
        pull_request: { number: 7, head: { ref: 'task/7-feat' }, html_url: 'https://github.com/o/r/pull/7' },
      });
      expect(ev).toMatchObject({ kind: 'review', prNumber: 7, branch: 'task/7-feat' });
    });

    it('returns null for a GitHub push event', () => {
      const ev = normalizeWebhookEvent('github', { 'x-github-event': 'push' }, { ref: 'refs/heads/main' });
      expect(ev).toBeNull();
    });
  });

  describe('parseTaskIdFromBranch', () => {
    it('should extract task ID from valid branch name', () => {
      expect(parseTaskIdFromBranch('task/123-add-feature')).toBe(123);
      expect(parseTaskIdFromBranch('task/1-x')).toBe(1);
      expect(parseTaskIdFromBranch('task/999-some-long-slug-name')).toBe(999);
    });

    it('should return null for non-matching branch names', () => {
      expect(parseTaskIdFromBranch('main')).toBe(null);
      expect(parseTaskIdFromBranch('feature/add-login')).toBe(null);
      expect(parseTaskIdFromBranch('task-123-missing-slash')).toBe(null);
      expect(parseTaskIdFromBranch('task/')).toBe(null);
      expect(parseTaskIdFromBranch('task/abc-not-a-number')).toBe(null);
    });

    it('should return null for null or undefined input', () => {
      expect(parseTaskIdFromBranch(null)).toBe(null);
      expect(parseTaskIdFromBranch(undefined)).toBe(null);
      expect(parseTaskIdFromBranch('')).toBe(null);
    });
  });

  describe('getConfiguredTrigger', () => {
    it('returns the configured trigger from app_settings', () => {
      vi.mocked(mockGetAppSetting).mockReturnValue('mybot');
      expect(getConfiguredTrigger()).toBe('mybot');
      expect(mockGetAppSetting).toHaveBeenCalledWith('github_pr_trigger');
    });

    it('falls back to "bottega" if the lookup returns falsy', () => {
      vi.mocked(mockGetAppSetting).mockReturnValue('');
      expect(getConfiguredTrigger()).toBe('bottega');
    });

    it('falls back to "bottega" if the database throws', () => {
      vi.mocked(mockGetAppSetting).mockImplementation(() => { throw new Error('db down'); });
      expect(getConfiguredTrigger()).toBe('bottega');
    });
  });

  describe('hasTriggerMention', () => {
    it('detects the default @bottega trigger from app_settings', () => {
      vi.mocked(mockGetAppSetting).mockReturnValue('bottega');
      expect(hasTriggerMention('@bottega please fix this')).toBe(true);
      expect(hasTriggerMention('Hey @bottega, can you help?')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(hasTriggerMention('@Bottega please fix', 'bottega')).toBe(true);
      expect(hasTriggerMention('@BOTTEGA please fix', 'bottega')).toBe(true);
      expect(hasTriggerMention('@BoTtEgA please fix', 'bottega')).toBe(true);
    });

    it('respects a custom trigger argument over the configured default', () => {
      vi.mocked(mockGetAppSetting).mockReturnValue('bottega');
      expect(hasTriggerMention('@acme please fix', 'acme')).toBe(true);
      expect(hasTriggerMention('@bottega please fix', 'acme')).toBe(false);
    });

    it('returns false when the trigger is absent', () => {
      expect(hasTriggerMention('Please fix this bug', 'bottega')).toBe(false);
      expect(hasTriggerMention('bottega without at sign', 'bottega')).toBe(false);
      expect(hasTriggerMention('', 'bottega')).toBe(false);
    });

    it('returns false for null or undefined comment bodies', () => {
      expect(hasTriggerMention(null, 'bottega')).toBe(false);
      expect(hasTriggerMention(undefined, 'bottega')).toBe(false);
    });
  });

  describe('triggerPrAgentFromComment', () => {
    const mockTask = {
      id: 123,
      status: 'in_progress',
      title: 'Test Task'
    };

    const mockTaskWithProject = {
      ...mockTask,
      user_id: 1,
      repo_folder_path: '/path/to/repo',
      project_id: 1
    };

    const mockUser = {
      id: 1,
      username: 'testuser'
    };

    const mockAgentRun = { id: 1, status: 'running' };
    const mockConversation = { id: 100 };

    beforeEach(() => {
      vi.mocked(mockGetById).mockReturnValue(mockTask);
      vi.mocked(mockGetWithProject).mockReturnValue(mockTaskWithProject);
      vi.mocked(mockGetUserById).mockReturnValue(mockUser);
      vi.mocked(mockWorktreeExists).mockResolvedValue(true);
      vi.mocked(mockGetByTask).mockReturnValue([]);
      vi.mocked(mockStartAgentRun).mockResolvedValue({
        agentRun: mockAgentRun,
        conversation: mockConversation,
        claudeSessionId: 'session-123'
      });
    });

    it('should trigger PR agent successfully', async () => {
      const result = await triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega please fix this',
        commentAuthor: 'octocat',
        prUrl: 'https://github.com/org/repo/pull/1',
        fileContext: null,
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      });

      expect(result.conversationId).toBe(100);
      expect(result.agentRunId).toBe(1);
      expect(mockStartAgentRun).toHaveBeenCalledWith(123, 'pr', expect.objectContaining({
        webhookContext: {
          commentBody: '@bottega please fix this',
          commentAuthor: 'octocat',
          prUrl: 'https://github.com/org/repo/pull/1',
          fileContext: null,
          triggeredBy: 'github_webhook'
        }
      }));
    });

    it('should include file context for inline review comments', async () => {
      const fileContext = {
        path: 'src/services/auth.js',
        line: 42,
        startLine: 40,
        diffHunk: '@@ -38,6 +38,12 @@ class AuthService\n+  validateToken() {',
        side: 'RIGHT'
      };

      const result = await triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega refactor this',
        commentAuthor: 'reviewer',
        prUrl: 'https://github.com/org/repo/pull/1',
        fileContext,
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      });

      expect(result.conversationId).toBe(100);
      expect(mockStartAgentRun).toHaveBeenCalledWith(123, 'pr', expect.objectContaining({
        webhookContext: {
          commentBody: '@bottega refactor this',
          commentAuthor: 'reviewer',
          prUrl: 'https://github.com/org/repo/pull/1',
          fileContext,
          triggeredBy: 'github_webhook'
        }
      }));
    });

    it('should throw error if task not found', async () => {
      vi.mocked(mockGetById).mockReturnValue(null);

      await expect(triggerPrAgentFromComment({
        taskId: 999,
        commentBody: '@bottega fix',
        commentAuthor: 'user',
        prUrl: 'https://github.com/org/repo/pull/1',
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      } as never)).rejects.toThrow('Task 999 not found');
    });

    it('should throw error if task is already completed', async () => {
      vi.mocked(mockGetById).mockReturnValue({ ...mockTask, status: 'completed' });

      await expect(triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega fix',
        commentAuthor: 'user',
        prUrl: 'https://github.com/org/repo/pull/1',
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      } as never)).rejects.toThrow('Task 123 is already completed');
    });

    it('should throw error if no worktree exists', async () => {
      vi.mocked(mockWorktreeExists).mockResolvedValue(false);

      await expect(triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega fix',
        commentAuthor: 'user',
        prUrl: 'https://github.com/org/repo/pull/1',
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      } as never)).rejects.toThrow('No worktree found for task 123');
    });

    it('should throw error if PR agent is already running', async () => {
      vi.mocked(mockGetByTask).mockReturnValue([
        { id: 1, agent_type: 'pr', status: 'running' }
      ]);

      await expect(triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega fix',
        commentAuthor: 'user',
        prUrl: 'https://github.com/org/repo/pull/1',
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      } as never)).rejects.toThrow('PR agent already running for task 123');
    });

    it('should not throw if non-PR agent is running', async () => {
      vi.mocked(mockGetByTask).mockReturnValue([
        { id: 1, agent_type: 'implementation', status: 'running' }
      ]);

      const result = await triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega fix',
        commentAuthor: 'user',
        prUrl: 'https://github.com/org/repo/pull/1',
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      } as never);

      expect(result.conversationId).toBe(100);
    });

    it('should throw if the task has no owning user', async () => {
      vi.mocked(mockGetWithProject).mockReturnValue({ ...mockTaskWithProject, user_id: null });

      await expect(triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega fix',
        commentAuthor: 'user',
        prUrl: 'https://github.com/org/repo/pull/1',
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      } as never)).rejects.toThrow('Task 123 has no owning user');
    });

    it('should throw if the task owner cannot be found (deactivated)', async () => {
      vi.mocked(mockGetUserById).mockReturnValue(null);

      await expect(triggerPrAgentFromComment({
        taskId: 123,
        commentBody: '@bottega fix',
        commentAuthor: 'user',
        prUrl: 'https://github.com/org/repo/pull/1',
        broadcastToConversationSubscribers: null as never,
        broadcastToTaskSubscribers: null as never
      } as never)).rejects.toThrow(/owner.*not found or inactive/);
    });
  });

  describe('triggerPrAgentFromReview', () => {
    const mockTask = {
      id: 123,
      status: 'in_progress',
      title: 'Test Task'
    };

    const mockTaskWithProject = {
      ...mockTask,
      user_id: 1,
      repo_folder_path: '/path/to/repo',
      project_id: 1
    };

    const mockUser = {
      id: 1,
      username: 'testuser'
    };

    const mockAgentRun = { id: 2, status: 'running' };
    const mockConversation = { id: 200 };

    const defaultReviewOptions = {
      taskId: 123,
      reviewBody: 'Please address these issues',
      reviewAuthor: 'reviewer',
      comments: [
        {
          commentBody: 'Fix this function',
          commentAuthor: 'reviewer',
          fileContext: {
            path: 'src/app.js',
            line: 10,
            startLine: null,
            diffHunk: '@@ -8,6 +8,12 @@\n+function foo() {}',
            side: 'RIGHT'
          }
        },
        {
          commentBody: 'Add validation here',
          commentAuthor: 'reviewer',
          fileContext: {
            path: 'src/routes.js',
            line: 25,
            startLine: 20,
            diffHunk: '@@ -18,10 +18,15 @@\n code',
            side: 'LEFT'
          }
        }
      ],
      prUrl: 'https://github.com/org/repo/pull/1',
      broadcastToConversationSubscribers: null as never,
      broadcastToTaskSubscribers: null as never
    };

    beforeEach(() => {
      vi.mocked(mockGetById).mockReturnValue(mockTask);
      vi.mocked(mockGetWithProject).mockReturnValue(mockTaskWithProject);
      vi.mocked(mockGetUserById).mockReturnValue(mockUser);
      vi.mocked(mockWorktreeExists).mockResolvedValue(true);
      vi.mocked(mockGetByTask).mockReturnValue([]);
      vi.mocked(mockStartAgentRun).mockResolvedValue({
        agentRun: mockAgentRun,
        conversation: mockConversation,
        claudeSessionId: 'session-456'
      });
    });

    it('should trigger PR agent with review context successfully', async () => {
      const result = await triggerPrAgentFromReview(defaultReviewOptions);

      expect(result.conversationId).toBe(200);
      expect(result.agentRunId).toBe(2);
      expect(mockStartAgentRun).toHaveBeenCalledWith(123, 'pr', expect.objectContaining({
        webhookContext: {
          reviewBody: 'Please address these issues',
          reviewAuthor: 'reviewer',
          comments: defaultReviewOptions.comments,
          prUrl: 'https://github.com/org/repo/pull/1',
          triggeredBy: 'github_webhook'
        }
      }));
    });

    it('should pass all comments to startAgentRun with correct webhookContext shape', async () => {
      await triggerPrAgentFromReview(defaultReviewOptions);

      const call = mockStartAgentRun.mock.calls[0];
      const webhookContext = call![2].webhookContext;

      expect(webhookContext.reviewBody).toBe('Please address these issues');
      expect(webhookContext.reviewAuthor).toBe('reviewer');
      expect(webhookContext.comments).toHaveLength(2);
      expect(webhookContext.comments[0].commentBody).toBe('Fix this function');
      expect(webhookContext.comments[0].fileContext.path).toBe('src/app.js');
      expect(webhookContext.comments[1].commentBody).toBe('Add validation here');
      expect(webhookContext.comments[1].fileContext.path).toBe('src/routes.js');
      expect(webhookContext.triggeredBy).toBe('github_webhook');
    });

    it('should handle review with null body', async () => {
      const result = await triggerPrAgentFromReview({
        ...defaultReviewOptions,
        reviewBody: null
      });

      expect(result.conversationId).toBe(200);
      const webhookContext = mockStartAgentRun.mock.calls[0]![2].webhookContext;
      expect(webhookContext.reviewBody).toBeNull();
    });

    it('should handle review with empty comments array', async () => {
      const result = await triggerPrAgentFromReview({
        ...defaultReviewOptions,
        comments: []
      });

      expect(result.conversationId).toBe(200);
      const webhookContext = mockStartAgentRun.mock.calls[0]![2].webhookContext;
      expect(webhookContext.comments).toEqual([]);
    });

    it('should throw error if task not found', async () => {
      vi.mocked(mockGetById).mockReturnValue(null);

      await expect(triggerPrAgentFromReview({
        ...defaultReviewOptions,
        taskId: 999
      })).rejects.toThrow('Task 999 not found');
    });

    it('should throw error if task is already completed', async () => {
      vi.mocked(mockGetById).mockReturnValue({ ...mockTask, status: 'completed' });

      await expect(triggerPrAgentFromReview(defaultReviewOptions as never))
        .rejects.toThrow('Task 123 is already completed');
    });

    it('should throw error if no worktree exists', async () => {
      vi.mocked(mockWorktreeExists).mockResolvedValue(false);

      await expect(triggerPrAgentFromReview(defaultReviewOptions as never))
        .rejects.toThrow('No worktree found for task 123');
    });

    it('should throw error if PR agent is already running', async () => {
      vi.mocked(mockGetByTask).mockReturnValue([
        { id: 1, agent_type: 'pr', status: 'running' }
      ]);

      await expect(triggerPrAgentFromReview(defaultReviewOptions as never))
        .rejects.toThrow('PR agent already running for task 123');
    });

    it('should not throw if non-PR agent is running', async () => {
      vi.mocked(mockGetByTask).mockReturnValue([
        { id: 1, agent_type: 'implementation', status: 'running' }
      ]);

      const result = await triggerPrAgentFromReview(defaultReviewOptions);
      expect(result.conversationId).toBe(200);
    });

    it('should throw if the task has no owning user', async () => {
      vi.mocked(mockGetWithProject).mockReturnValue({ ...mockTaskWithProject, user_id: null });

      await expect(triggerPrAgentFromReview(defaultReviewOptions as never))
        .rejects.toThrow('Task 123 has no owning user');
    });

    it('should throw if the task owner cannot be found (deactivated)', async () => {
      vi.mocked(mockGetUserById).mockReturnValue(null);

      await expect(triggerPrAgentFromReview(defaultReviewOptions as never))
        .rejects.toThrow(/owner.*not found or inactive/);
    });
  });
});
