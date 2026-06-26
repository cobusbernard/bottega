import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase, forgeConnectionsDb } from './db.js';

beforeEach(() => initializeDatabase());

describe('forgeConnectionsDb', () => {
  it('creates, lists, toggles, and removes a Forgejo connection', () => {
    const c = forgeConnectionsDb.create({ type: 'forgejo', name: 'Corp', base_url: 'https://git.example.com' });
    expect(c.id).toBeGreaterThan(0);
    expect(forgeConnectionsDb.listEnabled().some(r => r.id === c.id)).toBe(true);
    forgeConnectionsDb.setEnabled(c.id, false);
    expect(forgeConnectionsDb.listEnabled().some(r => r.id === c.id)).toBe(false);
    forgeConnectionsDb.remove(c.id);
    expect(forgeConnectionsDb.getById(c.id)).toBeUndefined();
  });
});
