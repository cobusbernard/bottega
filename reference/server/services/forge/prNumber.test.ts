import { describe, it, expect } from 'vitest';
import { parsePrNumberFromUrl } from './prNumber.js';

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

  it('handles trailing slash correctly', () => {
    // naive /\/(\d+)$/ would fail to match and return null (or 0 via parseInt)
    expect(parsePrNumberFromUrl('https://git.example.com/owner/repo/pulls/42/')).toBe(42);
  });

  it('handles query string suffix correctly', () => {
    // naive /\/(\d+)$/ would fail to match for …/pulls/42?x=1
    expect(parsePrNumberFromUrl('https://git.example.com/owner/repo/pulls/42?x=1')).toBe(42);
  });

  it('handles fragment suffix correctly', () => {
    expect(parsePrNumberFromUrl('https://git.example.com/owner/repo/pulls/42#comments')).toBe(42);
  });

  it('returns null for a URL with no pull(s) path segment', () => {
    expect(parsePrNumberFromUrl('https://git.example.com/owner/repo')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parsePrNumberFromUrl(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parsePrNumberFromUrl('')).toBeNull();
  });
});
