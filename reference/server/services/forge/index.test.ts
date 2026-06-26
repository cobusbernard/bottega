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
