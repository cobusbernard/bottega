import { tasksDb, projectsDb, forgeConnectionsDb } from '../../database/db.js';
import { getForgeToken } from '../forgeCredentials.js';
import { githubProvider } from './githubProvider.js';
import { forgejoProvider } from './forgejoProvider.js';
import { runCommand } from '../shell.js';
import { getWorktreePath } from '../worktree.js';
import type { ForgeProvider, ForgeContext } from './types.js';

export interface ResolvedForge {
  provider: ForgeProvider;
  ctx: ForgeContext;
  cli: 'gh' | 'forge';
}

/**
 * Parse owner and repo from a git remote URL.
 * Handles both HTTPS and SSH forms:
 *   https://host/owner/repo(.git)
 *   git@host:owner/repo(.git)
 */
export function parseRemoteUrl(remoteUrl: string): { owner: string; repo: string } {
  // SSH form: git@host:owner/repo(.git)
  const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }
  // HTTPS form: https://host/owner/repo(.git)
  const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }
  throw new Error(`Cannot parse owner/repo from remote URL: ${remoteUrl}`);
}

/**
 * Lightweight helper that reads the forge CLI name for a task without
 * parsing the git remote or throwing for misconfigured connections.
 * Returns 'forge' only when the project is linked to an enabled Forgejo
 * connection; defaults to 'gh' in all other cases.
 */
export function resolveForgeCli(taskId: number): 'gh' | 'forge' {
  const task = tasksDb.getById(taskId);
  if (!task) return 'gh';

  const project = projectsDb.getByIdAdmin(task.project_id);
  if (!project?.forge_connection_id) return 'gh';

  const connection = forgeConnectionsDb.getById(project.forge_connection_id);
  if (!connection) return 'gh';

  return connection.type === 'forgejo' ? 'forge' : 'gh';
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

  // Fall back to the first enabled GitHub connection when the project has none pinned.
  // We intentionally skip Forgejo connections here: without a project-level pin we
  // cannot know which Forgejo instance owns this repo, and `resolveForgeCli` likewise
  // returns 'gh' for unpinned projects — stay consistent.
  if (!connection) {
    const enabled = forgeConnectionsDb.listEnabled();
    connection = enabled.find((c) => c.type === 'github');
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

  // Forgejo path — resolve owner/repo from the project's git origin remote.
  if (connection.type === 'forgejo') {
    const { stdout } = await runCommand(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: project.repo_folder_path },
    );
    const { owner, repo } = parseRemoteUrl(stdout.trim());
    const token = getForgeToken(userId, connection.id);
    return {
      provider: forgejoProvider,
      ctx: {
        type: 'forgejo',
        baseUrl: connection.base_url,
        owner,
        repo,
        token,
        worktreePath,
      },
      cli: 'forge',
    };
  }

  throw new Error(`Unknown forge connection type: ${(connection as { type: string }).type}`);
}
