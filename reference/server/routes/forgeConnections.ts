import express, { type Request, type Response } from 'express';
import { forgeConnectionsDb } from '../database/db.js';
import type { ForgeConnectionRow } from '../../shared/types/db.js';
import type { ApiError } from '../../shared/api/_common.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  CreateForgeConnectionSchema,
  type CreateForgeConnection,
  SetEnabledSchema,
  type SetEnabled,
} from '../../shared/schemas/forge.js';
import {
  IdParamsSchema,
  type IdParams,
} from '../../shared/schemas/_common.js';

const router = express.Router();

router.get(
  '/',
  (_req: Request, res: Response<ForgeConnectionRow[] | ApiError>) => {
    try {
      const connections = forgeConnectionsDb.list();
      res.json(connections);
    } catch (error) {
      console.error('Error listing forge connections:', error);
      res.status(500).json({ error: 'Failed to list forge connections' });
    }
  },
);

router.post(
  '/',
  validateBody(CreateForgeConnectionSchema),
  (req: Request, res: Response<ForgeConnectionRow | ApiError>) => {
    try {
      const { type, name, base_url } = req.validated!.body as CreateForgeConnection;
      const connection = forgeConnectionsDb.create({ type, name, base_url });
      res.status(201).json(connection);
    } catch (error) {
      console.error('Error creating forge connection:', error);
      res.status(500).json({ error: 'Failed to create forge connection' });
    }
  },
);

router.patch(
  '/:id',
  validateParams(IdParamsSchema),
  validateBody(SetEnabledSchema),
  (req: Request, res: Response<{ success: true } | ApiError>) => {
    try {
      const { id } = req.validated!.params as IdParams;
      const { enabled } = req.validated!.body as SetEnabled;

      const existing = forgeConnectionsDb.getById(id);
      if (!existing) {
        return res.status(404).json({ error: 'Forge connection not found' });
      }

      forgeConnectionsDb.setEnabled(id, enabled);
      res.json({ success: true });
    } catch (error) {
      console.error('Error updating forge connection:', error);
      res.status(500).json({ error: 'Failed to update forge connection' });
    }
  },
);

router.delete(
  '/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<{ success: true } | ApiError>) => {
    try {
      const { id } = req.validated!.params as IdParams;

      const existing = forgeConnectionsDb.getById(id);
      if (!existing) {
        return res.status(404).json({ error: 'Forge connection not found' });
      }

      forgeConnectionsDb.remove(id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting forge connection:', error);
      res.status(500).json({ error: 'Failed to delete forge connection' });
    }
  },
);

export default router;
