import { describe, it, expect } from 'vitest';
import { parseForgeArgv, parsePrNumberFromUrl } from './forge.js';

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

describe('parsePrNumberFromUrl', () => {
  it('extracts PR number from a Forgejo /pulls/ URL', () => {
    expect(parsePrNumberFromUrl('https://git.example.com/owner/repo/pulls/42')).toBe(42);
  });

  it('extracts PR number from a GitHub /pull/ URL', () => {
    expect(parsePrNumberFromUrl('https://github.com/owner/repo/pull/7')).toBe(7);
  });

  it('ignores numeric namespace segment and returns the PR number', () => {
    // regression: /123/repo/pulls/42 must yield 42, not 123
    expect(parsePrNumberFromUrl('https://git.example.com/123/repo/pulls/42')).toBe(42);
  });

  it('returns null for a URL with no pull(s) path segment', () => {
    expect(parsePrNumberFromUrl('https://git.example.com/owner/repo')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parsePrNumberFromUrl(undefined)).toBeNull();
  });
});
