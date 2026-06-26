import fs from 'fs';
import path from 'path';
import { resolveClaudeUserDir } from './claudeCredentials.js';

const FORGE_TOKENS_DIR = 'forge_tokens';

function resolveForgeTokenPath(userId: number, connectionId: number): string {
  return path.join(resolveClaudeUserDir(userId), FORGE_TOKENS_DIR, String(connectionId));
}

export function setForgeToken(userId: number, connectionId: number, token: string): void {
  const tokenPath = resolveForgeTokenPath(userId, connectionId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
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
