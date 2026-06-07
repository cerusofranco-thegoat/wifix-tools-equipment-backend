/**
 * Schemas Zod del módulo Asistencia Técnica.
 * Fase 0: solo tipos y schemas de validación base (los handlers están en stub).
 * La lógica de negocio se implementa en la Fase B.
 */
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ASSISTANCE_STATUSES = [
  'REQUESTED',
  'QUEUED',
  'ASSIGNED',
  'ACTIVE',
  'ON_HOLD',
  'RESOLVED',
  'UNRESOLVED',
  'CANCELLED',
  'EXPIRED',
] as const;

export const REMOTE_ACTION_TYPES = [
  'REBOOT',
  'SET_WIFI',
  'SET_CHANNEL',
  'FACTORY_RESET',
  'REPROVISION',
  'RUN_DIAGNOSTIC',
] as const;

export const REMOTE_SESSION_CHANNELS = ['BROKER_TUNNEL', 'COBROWSE'] as const;

// ---------------------------------------------------------------------------
// Schemas de entrada — sesiones
// ---------------------------------------------------------------------------

export const createSessionSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
  visitId: z.string().optional(),
  reason: z.string().optional(),
  consent: z.literal(true, {
    errorMap: () => ({ message: 'Se requiere el consentimiento del cliente (consent: true).' }),
  }),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const listSessionsSchema = paginationSchema.extend({
  status: z.enum(ASSISTANCE_STATUSES).optional(),
  accountNumber: z.string().min(1).optional(),
});

export type ListSessionsInput = z.infer<typeof listSessionsSchema>;

export const changeStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'ON_HOLD', 'RESOLVED', 'UNRESOLVED', 'CANCELLED']),
  note: z.string().optional(),
});

export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;

export const addNoteSchema = z.object({
  note: z.string().min(1, 'note es obligatorio.'),
});

export type AddNoteInput = z.infer<typeof addNoteSchema>;

// ---------------------------------------------------------------------------
// Schemas de entrada — sesiones remotas
// ---------------------------------------------------------------------------

export const openRemoteSessionSchema = z
  .object({
    channel: z.enum(REMOTE_SESSION_CHANNELS),
    targetHost: z.string().optional(),
    ttlSeconds: z.number().int().min(1).max(1800).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.channel === 'BROKER_TUNNEL') {
      if (!data.targetHost || data.targetHost.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetHost'],
          message:
            'targetHost es obligatorio para una sesión de túnel; indique la IP del CPE en el LAN.',
        });
      }
    }
  });

export type OpenRemoteSessionInput = z.infer<typeof openRemoteSessionSchema>;

// ---------------------------------------------------------------------------
// Schemas de entrada — acciones ACS
// ---------------------------------------------------------------------------

const runDiagnosticParamsSchema = z.object({
  target: z.string().min(1, 'target es obligatorio para RUN_DIAGNOSTIC.'),
  kind: z.enum(['ping', 'traceroute'], {
    errorMap: () => ({ message: "kind debe ser 'ping' o 'traceroute'." }),
  }),
});

export const requestActionSchema = z
  .object({
    action: z.enum(REMOTE_ACTION_TYPES),
    params: z.record(z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.action === 'RUN_DIAGNOSTIC') {
      const parsed = runDiagnosticParamsSchema.safeParse(data.params);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['params', ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  });

export type RequestActionInput = z.infer<typeof requestActionSchema>;

// ---------------------------------------------------------------------------
// Schemas de entrada — tickets de operadora
// ---------------------------------------------------------------------------

export const createOperatorTicketSchema = z.object({
  kind: z.enum(['TICKET', 'FSM_ORDER']),
  description: z.string().min(1, 'description es obligatorio.'),
  scheduleTurno: z.boolean().optional(),
});

export type CreateOperatorTicketInput = z.infer<typeof createOperatorTicketSchema>;

// ---------------------------------------------------------------------------
// Schemas de entrada — auto-asistencia (Fase F)
// ---------------------------------------------------------------------------

export const applyRemediationSchema = z.object({
  remediationId: z.string().min(1, 'remediationId es obligatorio.'),
});

export type ApplyRemediationInput = z.infer<typeof applyRemediationSchema>;

// ---------------------------------------------------------------------------
// UUID param schema (reutilizable)
// ---------------------------------------------------------------------------

export const uuidParamSchema = z.object({
  id: z.string().uuid('El id debe ser un UUID v4 válido.'),
});

// ---------------------------------------------------------------------------
// Schema de paginación sin filtros adicionales (para events y actions)
// ---------------------------------------------------------------------------

export const paginationOnlySchema = paginationSchema;
