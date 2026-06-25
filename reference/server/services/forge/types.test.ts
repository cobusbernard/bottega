import { describe, it, expect } from 'vitest';
import type { ForgeProvider, ForgeContext } from './types.js';

describe('ForgeProvider types', () => {
  it('a stub satisfies the interface and ForgeContext shape', () => {
    const ctx: ForgeContext = {
      type: 'github', baseUrl: 'https://github.com', owner: 'o', repo: 'r',
      token: null, worktreePath: '/tmp/wt',
    };
    const stub: ForgeProvider = {
      createPR: async () => ({ url: 'u', number: 1 }),
      getPRStatus: async () => ({ success: true, exists: false }),
      mergePR: async () => undefined,
      getPRBranch: async () => null,
      getReviewComments: async () => [],
    };
    expect(ctx.type).toBe('github');
    expect(typeof stub.createPR).toBe('function');
  });
});
