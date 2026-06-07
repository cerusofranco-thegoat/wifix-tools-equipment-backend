/**
 * Servicio de tickets de operadora — POST /sessions/{id}/tickets (Fase F).
 *
 * Síncrono: si el conector falla → 502 CONNECTOR_ERROR.
 * Escribe AssistanceEvent + ConnectorCallLog.
 */

import { ApiError } from '../../middleware/error-handler.js';
import { getTicketingConnector } from '../../connectors/ticketing/index.js';
import { getFsmConnector } from '../../connectors/fsm/index.js';
import { getSchedulingConnector } from '../../connectors/scheduling/index.js';
import { withConnectorAudit } from '../../connectors/connector-audit.js';
import { assistanceRepository } from './assistance.repository.js';
import type { CreateOperatorTicketInput } from './assistance.schemas.js';

// ---------------------------------------------------------------------------
// Resultado del endpoint
// ---------------------------------------------------------------------------

export interface CreateTicketResult {
  externalId: string;
  kind: 'TICKET' | 'FSM_ORDER';
  status: string;
}

// ---------------------------------------------------------------------------
// Función principal
// ---------------------------------------------------------------------------

export async function createOperatorTicket(
  sessionId: string,
  input: CreateOperatorTicketInput,
  userId: string,
  role: string,
): Promise<CreateTicketResult> {
  const session = await assistanceRepository.findSessionById(sessionId);
  if (!session) {
    throw ApiError.notFound('Sesión de asistencia no encontrada.');
  }

  // Auth: AGENT asignado o SUPERVISOR
  if (role !== 'SUPERVISOR') {
    if (role !== 'AGENT' || session.agentId !== userId) {
      throw ApiError.forbidden(
        'Solo el agente asignado o un supervisor puede generar tickets de operadora.',
      );
    }
  }

  const accountNumber = session.accountNumber;
  let externalId: string;
  let status: string;

  if (input.kind === 'TICKET') {
    // --- TICKET via ticketing connector ---
    const ticketing = getTicketingConnector();

    let turnoId: string | undefined;
    if (input.scheduleTurno) {
      // Agendar turno primero (independiente; si falla se propaga como 502)
      const scheduling = getSchedulingConnector();
      const turno = await withConnectorAudit(
        {
          connector: 'scheduling',
          operation: 'agendarTurno',
          accountNumber,
          actorId: userId,
        },
        () =>
          scheduling.agendarTurno({
            accountNumber,
            notes: input.description,
          }),
        { accountNumber, description: input.description },
      );
      turnoId = turno.turnoId;
    }

    const ticketResult = await withConnectorAudit(
      {
        connector: 'ticketing',
        operation: 'generaTicket',
        accountNumber,
        actorId: userId,
      },
      () =>
        ticketing.generaTicket({
          accountNumber,
          description: input.description,
        }),
      { accountNumber, description: input.description },
    );

    externalId = ticketResult.ticketId;
    status = ticketResult.status;

    // Evento de auditoría en AssistanceEvent
    await assistanceRepository.createEvent({
      sessionId,
      type: 'ACTION',
      payload: {
        kind: 'TICKET',
        externalId,
        status,
        description: input.description,
        turnoId: turnoId ?? null,
      },
      actorId: userId,
    });
  } else {
    // --- FSM_ORDER via fsm connector ---
    const fsm = getFsmConnector();

    let turnoId: string | undefined;
    if (input.scheduleTurno) {
      const scheduling = getSchedulingConnector();
      const turno = await withConnectorAudit(
        {
          connector: 'scheduling',
          operation: 'agendarTurno',
          accountNumber,
          actorId: userId,
        },
        () =>
          scheduling.agendarTurno({
            accountNumber,
            notes: input.description,
          }),
        { accountNumber, description: input.description },
      );
      turnoId = turno.turnoId;
    }

    const orden = await withConnectorAudit(
      {
        connector: 'fsm',
        operation: 'creaFsmVistec',
        accountNumber,
        actorId: userId,
      },
      () =>
        fsm.creaFsmVistec({
          accountNumber,
          description: input.description,
          type: 'VISTEC',
        }),
      { accountNumber, description: input.description },
    );

    externalId = orden.ordenId;
    status = orden.status;

    await assistanceRepository.createEvent({
      sessionId,
      type: 'ACTION',
      payload: {
        kind: 'FSM_ORDER',
        externalId,
        status,
        description: input.description,
        turnoId: turnoId ?? null,
      },
      actorId: userId,
    });
  }

  return { externalId, kind: input.kind, status };
}
