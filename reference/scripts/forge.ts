#!/usr/bin/env node

/**
 * CLI wrapper for Forgejo projects, mirroring the `gh pr` subcommands.
 * For GitHub projects the agent keeps using the real `gh` binary;
 * for Forgejo projects it runs `tsx scripts/forge.ts pr ...` instead.
 *
 * Usage:
 *   tsx scripts/forge.ts pr create --title <t> --body <b> [--task <id>] [--user <id>]
 *   tsx scripts/forge.ts pr checks [--task <id>] [--user <id>]
 *   tsx scripts/forge.ts pr view --json url,state,mergeable [--task <id>] [--user <id>]
 *   tsx scripts/forge.ts pr merge [--task <id>] [--user <id>]
 */

import { initializeDatabase } from '../server/database/db.js';
import { resolveForgeProvider } from '../server/services/forge/index.js';
import { parseTaskIdFromBranch } from '../server/services/webhookService.js';
import { getBranchName } from '../server/services/worktree.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
};

/**
 * Parse argv array into cmd, sub, and flags.
 * `--flag value` → string; bare `--flag` → true.
 * Pure function; safe to import for unit testing with no side effects.
 */
export function parseForgeArgv(argv: string[]): {
  cmd: string;
  sub: string;
  flags: Record<string, string | boolean>;
} {
  const [cmd = '', sub = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { cmd, sub, flags };
}

/** Map CIStatus.status to a gh-compatible exit code. */
function ciStatusToExitCode(status: string | undefined): number {
  switch (status) {
    case 'passed': return 0;
    case 'pending': return 8;
    case 'failed': return 1;
    default: return 0; // none / unknown
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { cmd, sub, flags } = parseForgeArgv(argv);

  if (cmd !== 'pr') {
    console.error(`${colors.red}Error:${colors.reset} Unknown command '${cmd}'. Expected 'pr'.`);
    process.exit(1);
  }

  // Determine taskId: explicit --task flag takes precedence over branch-derived value.
  let taskId: number | null = null;
  if (typeof flags['task'] === 'string') {
    const parsed = parseInt(flags['task'], 10);
    if (!isNaN(parsed)) taskId = parsed;
  }

  if (taskId === null) {
    // Derive from current branch in cwd
    const branch = await getBranchName(process.cwd());
    taskId = parseTaskIdFromBranch(branch);
  }

  if (taskId === null) {
    console.error(
      `${colors.red}Error:${colors.reset} Cannot determine task ID. ` +
      `Provide --task <id> or run from a worktree on a task/NNN-... branch.`,
    );
    process.exit(1);
  }

  // userId: injected by the agent runner via --user flag
  const userFlag = flags['user'];
  if (typeof userFlag !== 'string' || userFlag === '') {
    console.error(`${colors.red}Error:${colors.reset} --user <id> is required.`);
    process.exit(1);
  }
  const userId = parseInt(userFlag, 10);
  if (isNaN(userId)) {
    console.error(`${colors.red}Error:${colors.reset} --user must be a number.`);
    process.exit(1);
  }

  await initializeDatabase();

  const { provider, ctx } = await resolveForgeProvider(taskId, userId);

  // Derive current branch for operations that need it
  const branch = await getBranchName(ctx.worktreePath) ?? '';

  switch (sub) {
    case 'create': {
      const title = typeof flags['title'] === 'string' ? flags['title'] : '';
      const body = typeof flags['body'] === 'string' ? flags['body'] : '';
      if (!title) {
        console.error(`${colors.red}Error:${colors.reset} --title is required for 'pr create'.`);
        process.exit(1);
      }
      const result = await provider.createPR(ctx, { branch, title, body });
      console.log(result.url);
      break;
    }

    case 'checks': {
      const status = await provider.getPRStatus(ctx, { branch });
      const ci = status.ciStatus;

      if (!ci || ci.checks.length === 0) {
        console.log('No checks found.');
      } else {
        for (const check of ci.checks) {
          const icon =
            check.bucket === 'pass' ? `${colors.green}✓${colors.reset}` :
            check.bucket === 'fail' ? `${colors.red}✗${colors.reset}` :
            `${colors.yellow}…${colors.reset}`;
          const name = check.name ?? '(unnamed)';
          const link = check.link ? `  ${check.link}` : '';
          console.log(`${icon}  ${name}${link}`);
        }
      }

      const exitCode = ciStatusToExitCode(ci?.status);
      process.exit(exitCode);
      break;
    }

    case 'view': {
      const jsonFlag = typeof flags['json'] === 'string' ? flags['json'] : '';
      const fields = jsonFlag ? jsonFlag.split(',').map((f) => f.trim()) : [];

      const status = await provider.getPRStatus(ctx, { branch });

      const full: Record<string, string | boolean | undefined> = {
        url: status.url,
        state: status.state,
        mergeable: status.mergeable,
        mergeStateStatus: status.mergeable, // alias for compatibility
      };

      const output: Record<string, string | boolean | undefined> =
        fields.length > 0
          ? Object.fromEntries(fields.map((f) => [f, full[f]]))
          : full;

      console.log(JSON.stringify(output));
      break;
    }

    case 'merge': {
      // Derive prNumber from getPRStatus; some providers may not expose it.
      const status = await provider.getPRStatus(ctx, { branch });

      // PullRequestStatusResult does not carry prNumber directly.
      // Attempt to extract it from the PR URL as a best-effort.
      const urlMatch = status.url?.match(/\/(\d+)(?:$|[/?#])/);
      const prNumber = urlMatch ? parseInt(urlMatch[1]!, 10) : NaN;

      if (isNaN(prNumber)) {
        console.error(
          `${colors.red}Error:${colors.reset} Cannot determine PR number from URL '${status.url ?? '(none)'}'. ` +
          `Open the PR manually and merge it, or pass the PR number explicitly in a future version.`,
        );
        process.exit(1);
      }

      await provider.mergePR(ctx, { prNumber });
      console.log(`${colors.green}${colors.bright}PR #${prNumber} merged.${colors.reset}`);
      break;
    }

    default: {
      console.error(`${colors.red}Error:${colors.reset} Unknown pr subcommand '${sub}'.`);
      process.exit(1);
    }
  }
}

// Guard: run main() only when this script is the entry point, not when imported for testing.
if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${colors.red}Error:${colors.reset}`, message);
    process.exit(1);
  });
}
