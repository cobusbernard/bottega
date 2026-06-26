// Runtime validation schemas for the `/api/admin/forge-connections` routes.

import { z } from 'zod';

export const CreateForgeConnectionSchema = z.object({
  type: z.enum(['github', 'forgejo']),
  name: z.string().min(1),
  base_url: z.string().min(1),
});
export type CreateForgeConnection = z.infer<typeof CreateForgeConnectionSchema>;

export const SetEnabledSchema = z.object({
  enabled: z.boolean(),
});
export type SetEnabled = z.infer<typeof SetEnabledSchema>;
