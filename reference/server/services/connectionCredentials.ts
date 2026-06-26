import fs from 'fs';
import path from 'path';
import { getClaudeConfigRoot } from './claudeCredentials.js';
import { assertValidPositiveInt } from './validators.js';

const CONNECTIONS_DIR = 'connections';
const TOKEN_FILE_NAME = 'token';

function resolveConnectionTokenPath(connectionId: number): string {
  assertValidPositiveInt(connectionId, 'connectionId');
  return path.join(getClaudeConfigRoot(), CONNECTIONS_DIR, String(connectionId), TOKEN_FILE_NAME);
}

export function setConnectionToken(connectionId: number, token: string): void {
  if (!token.trim()) {
    throw new Error('Refusing to persist empty connection bot token');
  }
  const tokenPath = resolveConnectionTokenPath(connectionId);
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(tokenPath, token.trim(), { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
}

export function getConnectionToken(connectionId: number): string | null {
  const tokenPath = resolveConnectionTokenPath(connectionId);
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function deleteConnectionToken(connectionId: number): void {
  const tokenPath = resolveConnectionTokenPath(connectionId);
  try {
    fs.unlinkSync(tokenPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
