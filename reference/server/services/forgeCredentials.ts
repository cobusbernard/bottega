import fs from 'fs';
import path from 'path';
import { resolveClaudeUserDir } from './claudeCredentials.js';
import { assertValidPositiveInt } from './validators.js';

const FORGE_TOKENS_DIR = 'forge_tokens';

function resolveForgeTokenPath(userId: number, connectionId: number): string {
  assertValidPositiveInt(userId, 'userId');
  assertValidPositiveInt(connectionId, 'connectionId');
  return path.join(resolveClaudeUserDir(userId), FORGE_TOKENS_DIR, String(connectionId));
}

export function setForgeToken(userId: number, connectionId: number, token: string): void {
  if (!token.trim()) {
    throw new Error('Refusing to persist empty forge token');
  }
  const tokenPath = resolveForgeTokenPath(userId, connectionId);
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(tokenPath, token.trim(), { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}

export function getForgeToken(userId: number, connectionId: number): string | null {
  const tokenPath = resolveForgeTokenPath(userId, connectionId);
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function deleteForgeToken(userId: number, connectionId: number): void {
  const tokenPath = resolveForgeTokenPath(userId, connectionId);
  try {
    fs.unlinkSync(tokenPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
