import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';

// Mock the database so tests run without a real bottega.db.
vi.mock('../database/db.js', () => ({
  forgeConnectionsDb: {
    listEnabled: vi.fn(),
  },
}));

import forgeConnectionsPublicRoutes from './forgeConnectionsPublic.js';
import { forgeConnectionsDb } from '../database/db.js';

const TEST_USER = { id: 1, username: 'testuser' };

function buildApp() {
  const app = express();
  app.use(express.json());
  // Simulate authenticateToken — attaches user so the route treats the request as authenticated.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = TEST_USER as never;
    next();
  });
  app.use('/api/forge-connections', forgeConnectionsPublicRoutes);
  return app;
}

const mockConnections = [
  { id: 1, type: 'github' as const, name: 'My GitHub', base_url: 'https://github.com', enabled: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, type: 'forgejo' as const, name: 'Self-hosted', base_url: 'https://git.example.com', enabled: 1, created_at: '2026-01-01T00:00:00Z' },
];

describe('GET /api/forge-connections (public — authenticated users)', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('returns the enabled connections array', async () => {
    vi.mocked(forgeConnectionsDb.listEnabled).mockReturnValue(mockConnections as never);

    const res = await request(app).get('/api/forge-connections');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('My GitHub');
    expect(res.body[1].name).toBe('Self-hosted');
    expect(forgeConnectionsDb.listEnabled).toHaveBeenCalled();
  });

  it('returns an empty array when no enabled connections exist', async () => {
    vi.mocked(forgeConnectionsDb.listEnabled).mockReturnValue([]);

    const res = await request(app).get('/api/forge-connections');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 500 when the database throws', async () => {
    vi.mocked(forgeConnectionsDb.listEnabled).mockImplementation(() => {
      throw new Error('DB is on fire');
    });

    const res = await request(app).get('/api/forge-connections');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to list forge connections');
  });
});
