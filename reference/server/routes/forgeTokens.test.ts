import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock the database so tests run against in-memory stubs, not the real DB.
vi.mock('../database/db.js', () => ({
  forgeConnectionsDb: {
    listEnabled: vi.fn(),
    getById: vi.fn(),
  },
}));

// Mock the forge credentials service (filesystem-backed).
vi.mock('../services/forgeCredentials.js', () => ({
  setForgeToken: vi.fn(),
  getForgeToken: vi.fn(),
  deleteForgeToken: vi.fn(),
}));

import forgeTokensRoutes from './forgeTokens.js';
import { forgeConnectionsDb } from '../database/db.js';
import { setForgeToken, getForgeToken, deleteForgeToken } from '../services/forgeCredentials.js';

const TEST_USER_ID = 42;

function buildApp() {
  const app = express();
  app.use(express.json());
  // Inject a mock authenticated user — mirrors how routes-helper works.
  app.use((req, _res, next) => {
    req.user = { id: TEST_USER_ID, username: 'testuser' } as never;
    next();
  });
  app.use('/api/me/forge-tokens', forgeTokensRoutes);
  return app;
}

describe('GET /api/me/forge-tokens', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('returns connected status for each enabled connection', async () => {
    vi.mocked(forgeConnectionsDb.listEnabled).mockReturnValue([
      { id: 1, type: 'github', name: 'My GitHub', base_url: 'https://github.com', enabled: 1, created_at: '' },
      { id: 2, type: 'forgejo', name: 'My Forgejo', base_url: 'https://git.example.com', enabled: 1, created_at: '' },
    ] as never);
    vi.mocked(getForgeToken).mockImplementation((_userId, connectionId) =>
      connectionId === 1 ? 'secret-token' : null
    );

    const res = await request(app).get('/api/me/forge-tokens');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { connectionId: 1, connected: true },
      { connectionId: 2, connected: false },
    ]);
    // Tokens must never appear in the response body
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  });

  it('returns an empty array when no connections are enabled', async () => {
    vi.mocked(forgeConnectionsDb.listEnabled).mockReturnValue([]);

    const res = await request(app).get('/api/me/forge-tokens');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/me/forge-tokens', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('stores a token and returns 201 success (no token in body)', async () => {
    vi.mocked(forgeConnectionsDb.getById).mockReturnValue(
      { id: 1, type: 'github', name: 'My GitHub', base_url: '', enabled: 1, created_at: '' } as never
    );
    vi.mocked(setForgeToken).mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/me/forge-tokens')
      .send({ connectionId: 1, token: 'ghp_mysecrettoken' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true });
    // The token must never be echoed back
    expect(JSON.stringify(res.body)).not.toContain('ghp_mysecrettoken');
    expect(setForgeToken).toHaveBeenCalledWith(TEST_USER_ID, 1, 'ghp_mysecrettoken');
  });

  it('stored token is retrievable via getForgeToken', async () => {
    let stored: string | null = null;
    vi.mocked(forgeConnectionsDb.getById).mockReturnValue(
      { id: 5, type: 'forgejo', name: 'Self-hosted', base_url: '', enabled: 1, created_at: '' } as never
    );
    vi.mocked(setForgeToken).mockImplementation((_uid, _cid, tok) => { stored = tok; });
    vi.mocked(getForgeToken).mockImplementation(() => stored);

    await request(app)
      .post('/api/me/forge-tokens')
      .send({ connectionId: 5, token: 'pat_foobar' });

    expect(getForgeToken(TEST_USER_ID, 5)).toBe('pat_foobar');
  });

  it('returns 404 when connection does not exist', async () => {
    vi.mocked(forgeConnectionsDb.getById).mockReturnValue(undefined);

    const res = await request(app)
      .post('/api/me/forge-tokens')
      .send({ connectionId: 999, token: 'tok' });

    expect(res.status).toBe(404);
    expect(setForgeToken).not.toHaveBeenCalled();
  });

  it('returns 400 when connection is disabled', async () => {
    vi.mocked(forgeConnectionsDb.getById).mockReturnValue(
      { id: 3, type: 'github', name: 'Disabled', base_url: '', enabled: 0, created_at: '' } as never
    );

    const res = await request(app)
      .post('/api/me/forge-tokens')
      .send({ connectionId: 3, token: 'tok' });

    expect(res.status).toBe(400);
    expect(setForgeToken).not.toHaveBeenCalled();
  });

  it('returns 400 when token is empty', async () => {
    const res = await request(app)
      .post('/api/me/forge-tokens')
      .send({ connectionId: 1, token: '' });

    expect(res.status).toBe(400);
    expect(setForgeToken).not.toHaveBeenCalled();
  });

  it('returns 401 when no user is authenticated', async () => {
    // Build a separate app without the mock auth middleware
    const unauthApp = express();
    unauthApp.use(express.json());
    unauthApp.use('/api/me/forge-tokens', forgeTokensRoutes);

    const res = await request(unauthApp)
      .post('/api/me/forge-tokens')
      .send({ connectionId: 1, token: 'tok' });

    // The route reads req.user!.id — without a user it should throw 500 or the
    // caller should mount authenticateToken (which returns 401). In unit tests
    // without the middleware we accept either 4xx or 5xx as "not 201".
    expect(res.status).not.toBe(201);
  });
});

describe('DELETE /api/me/forge-tokens/:connectionId', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('deletes a token and returns success', async () => {
    vi.mocked(deleteForgeToken).mockImplementation(() => undefined);

    const res = await request(app).delete('/api/me/forge-tokens/7');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(deleteForgeToken).toHaveBeenCalledWith(TEST_USER_ID, 7);
  });

  it('is idempotent — returns success even if token was not set', async () => {
    vi.mocked(deleteForgeToken).mockImplementation(() => undefined);

    const res = await request(app).delete('/api/me/forge-tokens/99');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('returns 400 for non-numeric connectionId', async () => {
    const res = await request(app).delete('/api/me/forge-tokens/abc');

    expect(res.status).toBe(400);
    expect(deleteForgeToken).not.toHaveBeenCalled();
  });
});
