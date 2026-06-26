// Read-only forge connections endpoint for authenticated (non-admin) users.
// Exposes only enabled connections — project forms use this to populate the
// forge selector. Mutate routes remain admin-only (admin.ts / forgeConnections.ts).

import express, { type Request, type Response } from 'express';
import { forgeConnectionsDb } from '../database/db.js';
import type { ForgeConnectionRow } from '../../shared/types/db.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

// GET /api/forge-connections — enabled connections only; no token required beyond user auth
router.get(
  '/',
  (_req: Request, res: Response<ForgeConnectionRow[] | ApiError>) => {
    try {
      const connections = forgeConnectionsDb.listEnabled();
      res.json(connections);
    } catch (error) {
      console.error('Error listing enabled forge connections:', error);
      res.status(500).json({ error: 'Failed to list forge connections' });
    }
  },
);

export default router;
