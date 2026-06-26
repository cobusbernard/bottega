import { tasksDb, projectsDb, forgeConnectionsDb } from '../../database/db.js';
import { getForgeToken } from '../forgeCredentials.js';
import { githubProvider } from './githubProvider.js';
import { getWorktreePath } from '../worktree.js';
import type { ForgeProvider, ForgeContext } from './types.js';

export interface ResolvedForge {
  provider: ForgeProvider;
  ctx: ForgeContext;
  cli: 'gh' | 'forge';
}

/**
 * Resolve which forge provider + context to use for a given task.
 *
 * Resolution order:
 *   task → project.forge_connection_id → forge_connections row
 *
 * If the project has no connection, fall back to the first enabled connection.
 * If there are none, synthesise a GitHub default so pure-GitHub installs need
 * no forge configuration at all.
 */
export async function resolveForgeProvider(
  taskId: number,
  userId: number,
): Promise<ResolvedForge> {
  const task = tasksDb.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const project = projectsDb.getById(task.project_id, userId);
  if (!project) throw new Error(`Project ${task.project_id} not found`);

  const worktreePath = getWorktreePath(project.repo_folder_path, taskId);

  const connectionId = project.forge_connection_id ?? null;
  let connection = connectionId != null ? forgeConnectionsDb.getById(connectionId) : undefined;

  // Fall back to the first enabled connection when the project has none pinned.
  if (!connection) {
    const enabled = forgeConnectionsDb.listEnabled();
    connection = enabled[0];
  }

  // GitHub path (explicit connection, or no connection at all → synthetic default).
  if (!connection || connection.type === 'github') {
    const baseUrl = connection?.base_url ?? 'https://github.com';
    const token = connection != null ? getForgeToken(userId, connection.id) : null;
    return {
      provider: githubProvider,
      ctx: {
        type: 'github',
        baseUrl,
        owner: '',
        repo: '',
        token,
        worktreePath,
      },
      cli: 'gh',
    };
  }

  // Forgejo path — provider is wired in Task 7.
  if (connection.type === 'forgejo') {
    throw new Error('Forgejo provider not yet wired — added in a later task');
  }

  throw new Error(`Unknown forge connection type: ${(connection as { type: string }).type}`);
}
