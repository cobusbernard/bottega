import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import forgeConnectionsRoutes from './forgeConnections.js';

// Mock the database module
vi.mock('../database/db.js', () => ({
  forgeConnectionsDb: {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
  },
  userDb: {
    isAdmin: vi.fn(),
  },
}));

// Mock connectionCredentials — tokens are write-only and must never be returned
vi.mock('../services/connectionCredentials.js', () => ({
  setConnectionToken: vi.fn(),
  getConnectionToken: vi.fn(),
  deleteConnectionToken: vi.fn(),
}));

import { forgeConnectionsDb, userDb } from '../database/db.js';
import { setConnectionToken, getConnectionToken, deleteConnectionToken } from '../services/connectionCredentials.js';

const adminUser = { id: 1, username: 'admin', is_admin: 1 };
const nonAdminUser = { id: 2, username: 'user', is_admin: 0 };

function makeApp(user: typeof adminUser | typeof nonAdminUser) {
  const app = express();
  app.use(express.json());
  // Simulate authenticateToken by attaching user to req
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = user as never;
    next();
  });
  // Simulate requireAdmin
  app.use((req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const isAdmin = userDb.isAdmin(userId);
    if (!isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  });
  app.use('/api/admin/forge-connections', forgeConnectionsRoutes);
  return app;
}

const mockConnection = {
  id: 1,
  type: 'github' as const,
  name: 'My GitHub',
  base_url: 'https://github.com',
  enabled: 1 as const,
  created_at: '2026-01-01T00:00:00Z',
};

describe('Forge Connections Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no bot token configured
    vi.mocked(getConnectionToken).mockReturnValue(null);
  });

  describe('admin access', () => {
    let app: ReturnType<typeof makeApp>;

    beforeEach(() => {
      vi.mocked(userDb.isAdmin).mockReturnValue(true);
      app = makeApp(adminUser);
    });

    describe('GET /api/admin/forge-connections', () => {
      it('returns a list of connections with botTokenConfigured field', async () => {
        vi.mocked(forgeConnectionsDb.list).mockReturnValue([mockConnection]);
        vi.mocked(getConnectionToken).mockReturnValue(null);

        const res = await request(app).get('/api/admin/forge-connections');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].name).toBe('My GitHub');
        expect(res.body[0].botTokenConfigured).toBe(false);
        expect(forgeConnectionsDb.list).toHaveBeenCalled();
      });

      it('reports botTokenConfigured:true when a token is stored', async () => {
        vi.mocked(forgeConnectionsDb.list).mockReturnValue([mockConnection]);
        vi.mocked(getConnectionToken).mockReturnValue('secret-token');

        const res = await request(app).get('/api/admin/forge-connections');

        expect(res.status).toBe(200);
        expect(res.body[0].botTokenConfigured).toBe(true);
        // Token value must NEVER appear in response
        expect(JSON.stringify(res.body)).not.toContain('secret-token');
      });

      it('returns an empty array when no connections exist', async () => {
        vi.mocked(forgeConnectionsDb.list).mockReturnValue([]);

        const res = await request(app).get('/api/admin/forge-connections');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });
    });

    describe('POST /api/admin/forge-connections', () => {
      it('creates a new connection and returns 201', async () => {
        vi.mocked(forgeConnectionsDb.create).mockReturnValue(mockConnection);

        const res = await request(app)
          .post('/api/admin/forge-connections')
          .send({ type: 'github', name: 'My GitHub', base_url: 'https://github.com' });

        expect(res.status).toBe(201);
        expect(res.body.name).toBe('My GitHub');
        expect(res.body.type).toBe('github');
        expect(res.body.botTokenConfigured).toBe(false);
        expect(forgeConnectionsDb.create).toHaveBeenCalledWith({
          type: 'github',
          name: 'My GitHub',
          base_url: 'https://github.com',
        });
      });

      it('returns 400 for invalid type', async () => {
        const res = await request(app)
          .post('/api/admin/forge-connections')
          .send({ type: 'bitbucket', name: 'Test', base_url: 'https://bitbucket.org' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(Array.isArray(res.body.issues)).toBe(true);
      });

      it('returns 400 for missing name', async () => {
        const res = await request(app)
          .post('/api/admin/forge-connections')
          .send({ type: 'github', base_url: 'https://github.com' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      });
    });

    describe('PATCH /api/admin/forge-connections/:id', () => {
      it('toggles enabled to false', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(mockConnection);

        const res = await request(app)
          .patch('/api/admin/forge-connections/1')
          .send({ enabled: false });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(forgeConnectionsDb.setEnabled).toHaveBeenCalledWith(1, false);
      });

      it('returns 404 when connection does not exist', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(undefined);

        const res = await request(app)
          .patch('/api/admin/forge-connections/999')
          .send({ enabled: true });

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('not found');
      });

      it('returns 400 when enabled field is missing', async () => {
        const res = await request(app)
          .patch('/api/admin/forge-connections/1')
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      });
    });

    describe('PUT /api/admin/forge-connections/:id/token', () => {
      it('stores the token and responds with ok:true — no token in response', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(mockConnection);

        const res = await request(app)
          .put('/api/admin/forge-connections/1/token')
          .send({ token: 'my-secret-token' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        // Token must never be echoed back
        expect(JSON.stringify(res.body)).not.toContain('my-secret-token');
        expect(setConnectionToken).toHaveBeenCalledWith(1, 'my-secret-token');
      });

      it('returns 404 when connection does not exist', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(undefined);

        const res = await request(app)
          .put('/api/admin/forge-connections/999/token')
          .send({ token: 'tok' });

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('not found');
        expect(setConnectionToken).not.toHaveBeenCalled();
      });

      it('returns 400 when token is empty string', async () => {
        const res = await request(app)
          .put('/api/admin/forge-connections/1/token')
          .send({ token: '' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      });

      it('returns 400 when token field is missing', async () => {
        const res = await request(app)
          .put('/api/admin/forge-connections/1/token')
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      });
    });

    describe('DELETE /api/admin/forge-connections/:id/token', () => {
      it('deletes the token and responds with ok:true', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(mockConnection);

        const res = await request(app).delete('/api/admin/forge-connections/1/token');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(deleteConnectionToken).toHaveBeenCalledWith(1);
      });

      it('returns 404 when connection does not exist', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(undefined);

        const res = await request(app).delete('/api/admin/forge-connections/999/token');

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('not found');
        expect(deleteConnectionToken).not.toHaveBeenCalled();
      });
    });

    describe('DELETE /api/admin/forge-connections/:id', () => {
      it('removes a connection', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(mockConnection);

        const res = await request(app).delete('/api/admin/forge-connections/1');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(forgeConnectionsDb.remove).toHaveBeenCalledWith(1);
      });

      it('returns 404 when connection does not exist', async () => {
        vi.mocked(forgeConnectionsDb.getById).mockReturnValue(undefined);

        const res = await request(app).delete('/api/admin/forge-connections/999');

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('not found');
      });
    });
  });

  describe('non-admin access', () => {
    let app: ReturnType<typeof makeApp>;

    beforeEach(() => {
      vi.mocked(userDb.isAdmin).mockReturnValue(false);
      app = makeApp(nonAdminUser);
    });

    it('GET returns 403', async () => {
      const res = await request(app).get('/api/admin/forge-connections');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Admin access required');
    });

    it('POST returns 403', async () => {
      const res = await request(app)
        .post('/api/admin/forge-connections')
        .send({ type: 'github', name: 'Test', base_url: 'https://github.com' });
      expect(res.status).toBe(403);
    });

    it('PATCH returns 403', async () => {
      const res = await request(app)
        .patch('/api/admin/forge-connections/1')
        .send({ enabled: true });
      expect(res.status).toBe(403);
    });

    it('PUT token returns 403', async () => {
      const res = await request(app)
        .put('/api/admin/forge-connections/1/token')
        .send({ token: 'tok' });
      expect(res.status).toBe(403);
    });

    it('DELETE token returns 403', async () => {
      const res = await request(app).delete('/api/admin/forge-connections/1/token');
      expect(res.status).toBe(403);
    });

    it('DELETE returns 403', async () => {
      const res = await request(app).delete('/api/admin/forge-connections/1');
      expect(res.status).toBe(403);
    });
  });
});
