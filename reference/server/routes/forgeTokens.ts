// Per-user forge PAT (personal access token) storage.
// Tokens are written to disk via forgeCredentials.ts and NEVER returned in
// any response — callers receive only a connected/disconnected status.

import express, { type Request, type Response } from 'express';
import {
  setForgeToken,
  getForgeToken,
  deleteForgeToken,
} from '../services/forgeCredentials.js';
import { forgeConnectionsDb } from '../database/db.js';
import type { ApiError } from '../../shared/api/_common.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  SetForgeTokenSchema,
  type SetForgeToken,
} from '../../shared/schemas/forge.js';
import { z } from 'zod';

const router = express.Router();

const ConnectionIdParamsSchema = z.object({
  connectionId: z.coerce.number().int().positive(),
});
type ConnectionIdParams = z.infer<typeof ConnectionIdParamsSchema>;

// GET /api/me/forge-tokens — returns connected status per enabled connection
// (never returns token values)
router.get(
  '/',
  (req: Request, res: Response<{ connectionId: number; connected: boolean }[] | ApiError>) => {
    try {
      const userId = req.user!.id;
      const connections = forgeConnectionsDb.listEnabled();
      const statuses = connections.map((conn) => ({
        connectionId: conn.id,
        connected: getForgeToken(userId, conn.id) !== null,
      }));
      res.json(statuses);
    } catch (error) {
      console.error('[forgeTokens] Error listing token status:', error);
      res.status(500).json({ error: 'Failed to list forge token status' });
    }
  },
);

// POST /api/me/forge-tokens — store a PAT for a specific connection
router.post(
  '/',
  validateBody(SetForgeTokenSchema),
  (req: Request, res: Response<{ success: true } | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { connectionId, token } = req.validated!.body as SetForgeToken;

      // Verify the connection exists and is enabled
      const connection = forgeConnectionsDb.getById(connectionId);
      if (!connection) {
        return res.status(404).json({ error: 'Forge connection not found' });
      }
      if (!connection.enabled) {
        return res.status(400).json({ error: 'Forge connection is not enabled' });
      }

      setForgeToken(userId, connectionId, token);
      res.status(201).json({ success: true });
    } catch (error) {
      console.error('[forgeTokens] Error storing forge token:', error);
      res.status(500).json({ error: 'Failed to store forge token' });
    }
  },
);

// DELETE /api/me/forge-tokens/:connectionId — remove a stored PAT
router.delete(
  '/:connectionId',
  validateParams(ConnectionIdParamsSchema),
  (req: Request, res: Response<{ success: true } | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { connectionId } = req.validated!.params as ConnectionIdParams;

      deleteForgeToken(userId, connectionId);
      res.json({ success: true });
    } catch (error) {
      console.error('[forgeTokens] Error deleting forge token:', error);
      res.status(500).json({ error: 'Failed to delete forge token' });
    }
  },
);

export default router;
