import { describe, it, expect } from 'vitest';
import { parseForgeArgv } from './forge.js';

describe('parseForgeArgv', () => {
  it('parses `pr create --title T --body B`', () => {
    const r = parseForgeArgv(['pr', 'create', '--title', 'T', '--body', 'B']);
    expect(r).toEqual({ cmd: 'pr', sub: 'create', flags: { title: 'T', body: 'B' } });
  });

  it('parses `pr checks`', () => {
    expect(parseForgeArgv(['pr', 'checks'])).toEqual({ cmd: 'pr', sub: 'checks', flags: {} });
  });

  it('parses `pr view --json url,state,mergeable`', () => {
    const r = parseForgeArgv(['pr', 'view', '--json', 'url,state,mergeable']);
    expect(r).toEqual({ cmd: 'pr', sub: 'view', flags: { json: 'url,state,mergeable' } });
  });

  it('parses `pr merge`', () => {
    expect(parseForgeArgv(['pr', 'merge'])).toEqual({ cmd: 'pr', sub: 'merge', flags: {} });
  });

  it('parses bare flags as boolean true', () => {
    const r = parseForgeArgv(['pr', 'merge', '--squash']);
    expect(r).toEqual({ cmd: 'pr', sub: 'merge', flags: { squash: true } });
  });

  it('parses --task and --user flags', () => {
    const r = parseForgeArgv(['pr', 'create', '--title', 'X', '--body', 'Y', '--task', '42', '--user', '7']);
    expect(r).toEqual({ cmd: 'pr', sub: 'create', flags: { title: 'X', body: 'Y', task: '42', user: '7' } });
  });
});
