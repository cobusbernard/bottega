import { describe, it, expect, vi } from 'vitest';
import type { ProjectRow, TaskRow } from '../../../shared/types/db.js';
import type { ForgeConnectionRow } from '../../../shared/types/db.js';

vi.mock('../../database/db.js', () => ({
  tasksDb: { getById: vi.fn(() => ({ id: 1, project_id: 9 })) },
  projectsDb: {
    getById: vi.fn(() => ({ id: 9, repo_folder_path: '/repo', forge_connection_id: null })),
    getByIdAdmin: vi.fn(() => ({ id: 9, repo_folder_path: '/repo', forge_connection_id: null })),
  },
  forgeConnectionsDb: { getById: vi.fn(() => undefined), listEnabled: vi.fn(() => []) },
}));
vi.mock('../forgeCredentials.js', () => ({ getForgeToken: vi.fn(() => 'test-token') }));
vi.mock('../shell.js', () => ({
  runCommand: vi.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
}));

import { resolveForgeProvider, parseRemoteUrl, resolveForgeCli } from './index.js';
import { tasksDb, projectsDb, forgeConnectionsDb } from '../../database/db.js';
import { runCommand } from '../shell.js';

describe('resolveForgeProvider', () => {
  it('defaults to GitHub when the project has no connection', async () => {
    const r = await resolveForgeProvider(1, 100);
    expect(r.cli).toBe('gh');
    expect(r.ctx.type).toBe('github');
  });

  it('returns forgejo provider when connection type is forgejo', async () => {
    vi.mocked(forgeConnectionsDb.getById).mockReturnValueOnce({
      id: 42,
      type: 'forgejo',
      name: 'Corp Forge',
      base_url: 'https://git.example.com',
      enabled: 1,
      created_at: '',
    } satisfies ForgeConnectionRow);
    vi.mocked(projectsDb.getById).mockReturnValueOnce({
      id: 9,
      user_id: 1,
      name: 'test',
      repo_folder_path: '/repo',
      subproject_path: null,
      active_worktree_task_id: null,
      serve_symlink_path: null,
      systemd_service_name: null,
      app_url: null,
      forge_connection_id: 42,
      created_at: '',
      updated_at: '',
    } satisfies ProjectRow);
    vi.mocked(tasksDb.getById).mockReturnValueOnce({
      id: 1, project_id: 9,
      user_id: null, title: null, status: 'pending',
      workflow_complete: 0, workflow_blocked: 0, workflow_run_count: 0,
      planification_complete: 0, pr_agent_complete: 0, refinement_complete: 0,
      yolo_mode: 0, completed_at: null, created_at: '', updated_at: '',
    } satisfies TaskRow);
    vi.mocked(runCommand).mockResolvedValueOnce({
      stdout: 'https://git.example.com/myorg/myrepo.git',
      stderr: '',
    });

    const r = await resolveForgeProvider(1, 100);
    expect(r.cli).toBe('forge');
    expect(r.ctx.type).toBe('forgejo');
    expect(r.ctx.baseUrl).toBe('https://git.example.com');
    expect(r.ctx.owner).toBe('myorg');
    expect(r.ctx.repo).toBe('myrepo');
  });
});

describe('resolveForgeCli', () => {
  it('returns gh when the project has no forge connection', () => {
    // Default mocks: project.forge_connection_id = null
    expect(resolveForgeCli(1)).toBe('gh');
  });

  it('returns gh when the connection is of type github', () => {
    vi.mocked(forgeConnectionsDb.getById).mockReturnValueOnce({
      id: 10,
      type: 'github',
      name: 'GitHub',
      base_url: 'https://github.com',
      enabled: 1,
      created_at: '',
    } satisfies ForgeConnectionRow);
    vi.mocked(projectsDb.getByIdAdmin).mockReturnValueOnce({
      id: 9,
      user_id: 1,
      name: 'test',
      repo_folder_path: '/repo',
      subproject_path: null,
      active_worktree_task_id: null,
      serve_symlink_path: null,
      systemd_service_name: null,
      app_url: null,
      forge_connection_id: 10,
      created_at: '',
      updated_at: '',
    } satisfies ProjectRow);
    expect(resolveForgeCli(1)).toBe('gh');
  });

  it('returns forge when the connection is of type forgejo', () => {
    vi.mocked(forgeConnectionsDb.getById).mockReturnValueOnce({
      id: 20,
      type: 'forgejo',
      name: 'Corp Forge',
      base_url: 'https://git.example.com',
      enabled: 1,
      created_at: '',
    } satisfies ForgeConnectionRow);
    vi.mocked(projectsDb.getByIdAdmin).mockReturnValueOnce({
      id: 9,
      user_id: 1,
      name: 'test',
      repo_folder_path: '/repo',
      subproject_path: null,
      active_worktree_task_id: null,
      serve_symlink_path: null,
      systemd_service_name: null,
      app_url: null,
      forge_connection_id: 20,
      created_at: '',
      updated_at: '',
    } satisfies ProjectRow);
    expect(resolveForgeCli(1)).toBe('forge');
  });
});

describe('parseRemoteUrl', () => {
  it('parses HTTPS URL without .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses HTTPS URL with .git suffix', () => {
    expect(parseRemoteUrl('https://git.example.com/org/project.git')).toEqual({ owner: 'org', repo: 'project' });
  });

  it('parses SSH URL without .git suffix', () => {
    expect(parseRemoteUrl('git@github.com:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses SSH URL with .git suffix', () => {
    expect(parseRemoteUrl('git@git.example.com:myorg/myrepo.git')).toEqual({ owner: 'myorg', repo: 'myrepo' });
  });

  it('throws on unrecognised format', () => {
    expect(() => parseRemoteUrl('not-a-url')).toThrow('Cannot parse owner/repo from remote URL');
  });
});
