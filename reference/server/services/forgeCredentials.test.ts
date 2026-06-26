import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setForgeToken, getForgeToken, deleteForgeToken } from './forgeCredentials.js';

describe('forgeCredentials', () => {
  let tempRoot: string;
  let originalClaudeConfigRoot: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-forge-creds-'));
    originalClaudeConfigRoot = process.env.CLAUDE_CONFIG_ROOT;
    process.env.CLAUDE_CONFIG_ROOT = tempRoot;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });

    if (originalClaudeConfigRoot === undefined) {
      delete process.env.CLAUDE_CONFIG_ROOT;
    } else {
      process.env.CLAUDE_CONFIG_ROOT = originalClaudeConfigRoot;
    }
  });

  it('round-trips a token per (user, connection)', () => {
    setForgeToken(1, 5, 'pat_abc');
    expect(getForgeToken(1, 5)).toBe('pat_abc');
    expect(getForgeToken(1, 6)).toBeNull();
    deleteForgeToken(1, 5);
    expect(getForgeToken(1, 5)).toBeNull();
  });

  it('writes token files with mode 0600', () => {
    setForgeToken(1, 5, 'pat_abc');
    const tokenPath = path.join(tempRoot, '1', 'forge_tokens', '5');
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('trims whitespace on read', () => {
    setForgeToken(1, 5, '  pat_trimmed  ');
    expect(getForgeToken(1, 5)).toBe('pat_trimmed');
  });

  it('deleteForgeToken is idempotent when file is absent', () => {
    expect(() => deleteForgeToken(1, 99)).not.toThrow();
  });
});
