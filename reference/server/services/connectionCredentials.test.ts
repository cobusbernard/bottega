import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setConnectionToken, getConnectionToken, deleteConnectionToken } from './connectionCredentials.js';

describe('connectionCredentials', () => {
  let tempRoot: string;
  let originalClaudeConfigRoot: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-conn-creds-'));
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

  it('round-trips a token per connectionId', () => {
    setConnectionToken(5, 'bot_abc');
    expect(getConnectionToken(5)).toBe('bot_abc');
    expect(getConnectionToken(6)).toBeNull();
    deleteConnectionToken(5);
    expect(getConnectionToken(5)).toBeNull();
  });

  it('writes token files with mode 0600', () => {
    setConnectionToken(5, 'bot_abc');
    const tokenPath = path.join(tempRoot, 'connections', '5', 'token');
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('trims whitespace on read', () => {
    setConnectionToken(5, '  bot_trimmed  ');
    expect(getConnectionToken(5)).toBe('bot_trimmed');
  });

  it('deleteConnectionToken is idempotent when file is absent', () => {
    expect(() => deleteConnectionToken(99)).not.toThrow();
  });

  describe('id validation — all three functions reject invalid ids', () => {
    const cases: Array<[string, number]> = [
      ['zero connectionId', 0],
      ['negative connectionId', -1],
      ['non-integer connectionId', 1.5],
    ];

    for (const [label, badConnId] of cases) {
      it(`setConnectionToken throws on ${label}`, () => {
        expect(() => setConnectionToken(badConnId, 'tok')).toThrow();
      });

      it(`getConnectionToken throws on ${label}`, () => {
        expect(() => getConnectionToken(badConnId)).toThrow();
      });

      it(`deleteConnectionToken throws on ${label}`, () => {
        expect(() => deleteConnectionToken(badConnId)).toThrow();
      });
    }
  });

  it('connections directory is created with mode 0700', () => {
    setConnectionToken(5, 'bot_abc');
    const dir = path.join(tempRoot, 'connections', '5');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('setConnectionToken throws on whitespace-only token and writes no file', () => {
    expect(() => setConnectionToken(5, '   ')).toThrow();
    const tokenPath = path.join(tempRoot, 'connections', '5', 'token');
    expect(fs.existsSync(tokenPath)).toBe(false);
  });
});
