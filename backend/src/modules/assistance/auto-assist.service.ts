/**
 * Servicio de auto-asistencia (Fase F).
 *
 * Flujo:
 * 1. GET /sessions/{id}/auto-assist — corre estudio + telemetría de planta,
 *    detecta causas, propone remediaciones. NO aplica nada.
 * 2. POST /sessions/{id}/auto-assist/apply — aplica una remediación propuesta
 *    (requiere AGENT asignado + sesión ACTIVE + consentAt).
 *    Guarda estado previo para reversión. Auditado.
 */

import pino from 'pino';
import { ApiError } from '../../middleware/error-handler.js';
import { getIspMonitorConnector } from '../../connectors/ispmonitor/index.js';
import { getAcsConnector } from '../../connectors/acs/index.js';
import type { WifiBand } from '../../connectors/acs/index.js';
import { withConnectorAudit } from '../../connectors/connector-audit.js';
import {
  detectCausesAndProposals,
  type AutoAssistMetrics,
  type DetectedCause,
  type ProposedRemediation,
  type RemediationAction,
} from './auto-assist.rules.js';
import { assistanceRepository } from './assistance.repository.js';
import { broadcastActionResult } from './assistance.hub.js';
import { mapRemoteAction } from './assistance.mappers.js';
import { env } from '../../config/env.js';

const logger = pino({ name: 'auto-assist.service', level: env.LOG_LEVEL });

// ---------------------------------------------------------------------------
// Tipos de salida
// ---------------------------------------------------------------------------

export interface AutoAssistAnalysis {
  accountNumber: string;
  sessionId: string;
  causes: DetectedCause[];
  proposals: ProposedRemediation[];
  analysedAt: string;
}

export interface ApplyRemediationInput {
  remediationId: string;
}

export interface ApplyRemediationResult {
  remediationId: string;
  action: RemediationAction;
  status: 'APPLIED' | 'FAILED';
  message: string;
  /** Estado anterior guardado para reversión (nulo si no aplicable). */
  previousState: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// GET /sessions/{id}/auto-assist — análisis sin efectos
// ---------------------------------------------------------------------------

export async function getAutoAssistAnalysis(
  sessionId: string,
  userId: string,
  role: string,
): Promise<AutoAssistAnalysis> {
  const session = await assistanceRepository.findSessionById(sessionId);
  if (!session) {
    throw ApiError.notFound('Sesión de asistencia no encontrada.');
  }

  // Auth: participantes o SUPERVISOR
  if (role !== 'SUPERVISOR') {
    if (session.technicianId !== userId && session.agentId !== userId) {
      throw ApiError.forbidden('No tiene acceso a esta sesión de asistencia.');
    }
  }

  const accountNumber = session.accountNumber;
  const ispMonitor = getIspMonitorConnector();
  const acs = getAcsConnector();

  // Recopilar métricas — si alguna falla, registramos null (no rompemos)
  let plant: AutoAssistMetrics['plant'] = null;
  let wifiDeviceCount: number | null = null;
  let avgWifiSignalDbm: number | null = null;
  let wifiChannel24: number | null = null;
  let wifiChannel5: number | null = null;

  try {
    plant = await withConnectorAudit(
      { connector: 'ispmonitor', operation: 'getPlantTelemetry', accountNumber, actorId: userId },
      () => ispMonitor.getPlantTelemetry(accountNumber),
      { accountNumber },
    );
  } catch (err) {
    logger.warn({ sessionId, err }, 'Auto-asistencia: no se pudo obtener telemetría de planta');
  }

  try {
    const [lanDevices, wifiDevices, wifiConfig] = await Promise.all([
      withConnectorAudit(
        { connector: 'acs', operation: 'getLanDevices', accountNumber, actorId: userId },
        () => acs.getLanDevices(accountNumber),
        { accountNumber },
      ),
      withConnectorAudit(
        { connector: 'acs', operation: 'getWifiDevices', accountNumber, actorId: userId },
        () => acs.getWifiDevices(accountNumber),
        { accountNumber },
      ),
      withConnectorAudit(
        { connector: 'acs', operation: 'getWifiConfig', accountNumber, actorId: userId },
        () => acs.getWifiConfig(accountNumber),
        { accountNumber },
      ),
    ]);

    wifiDeviceCount = wifiDevices.length;

    if (wifiDevices.length > 0) {
      const signals = wifiDevices.map((d) => d.signalDbm).filter((s) => s !== undefined) as number[];
      if (signals.length > 0) {
        avgWifiSignalDbm = Math.round(signals.reduce((a, b) => a + b, 0) / signals.length);
      }
    }

    // Canales actuales de WiFi config (2.4GHz y 5GHz)
    // El conector ACS no expone canal directamente, pero lo derivamos del config
    // (en el mock el campo no existe; usamos null por defecto)
    void lanDevices; // referenciamos para evitar unused-var en compilador

    const band24 = wifiConfig.bands.find((b) => b.band === '2.4GHz');
    const band5 = wifiConfig.bands.find((b) => b.band === '5GHz');
    // Los tipos WifiBandConfig no tienen channel; dejamos null para el cálculo
    void band24;
    void band5;
  } catch (err) {
    logger.warn({ sessionId, err }, 'Auto-asistencia: no se pudieron obtener métricas ACS');
  }

  const metrics: AutoAssistMetrics = {
    plant,
    wifiDeviceCount,
    wifiChannel24,
    wifiChannel5,
    avgWifiSignalDbm,
  };

  const { causes, proposals } = detectCausesAndProposals(metrics);

  return {
    accountNumber,
    sessionId,
    causes,
    proposals,
    analysedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /sessions/{id}/auto-assist/apply — aplica una remediación
// ---------------------------------------------------------------------------

export async function applyRemediation(
  sessionId: string,
  input: ApplyRemediationInput,
  userId: string,
): Promise<ApplyRemediationResult> {
  const session = await assistanceRepository.findSessionById(sessionId);
  if (!session) {
    throw ApiError.notFound('Sesión de asistencia no encontrada.');
  }

  // Solo agente asignado
  if (session.agentId !== userId) {
    throw ApiError.forbidden('Solo el agente asignado puede aplicar remediaciones automáticas.');
  }

  // Sesión debe estar ACTIVE
  if (session.status !== 'ACTIVE') {
    throw ApiError.conflict('Solo se pueden aplicar remediaciones en sesiones ACTIVE.');
  }

  // Consentimiento obligatorio (gating de primera clase)
  if (!session.consentAt) {
    throw ApiError.conflict(
      'No se puede aplicar una remediación automática sin consentimiento previo del cliente.',
    );
  }

  const accountNumber = session.accountNumber;

  // Re-analizar para obtener la propuesta actual (no guardamos propuestas en BD)
  const ispMonitor = getIspMonitorConnector();
  const acs = getAcsConnector();

  let plant: AutoAssistMetrics['plant'] = null;
  let wifiDeviceCount: number | null = null;
  let avgWifiSignalDbm: number | null = null;

  try {
    plant = await withConnectorAudit(
      { connector: 'ispmonitor', operation: 'getPlantTelemetry', accountNumber, actorId: userId },
      () => ispMonitor.getPlantTelemetry(accountNumber),
      { accountNumber },
    );
  } catch {
    // Continuamos con plant = null
  }

  try {
    const wifiDevices = await withConnectorAudit(
      { connector: 'acs', operation: 'getWifiDevices', accountNumber, actorId: userId },
      () => acs.getWifiDevices(accountNumber),
      { accountNumber },
    );
    wifiDeviceCount = wifiDevices.length;
    if (wifiDevices.length > 0) {
      const signals = wifiDevices.map((d) => d.signalDbm).filter((s) => s !== undefined) as number[];
      if (signals.length > 0) {
        avgWifiSignalDbm = Math.round(signals.reduce((a, b) => a + b, 0) / signals.length);
      }
    }
  } catch {
    // Continuamos con valores null
  }

  const metrics: AutoAssistMetrics = {
    plant,
    wifiDeviceCount,
    wifiChannel24: null,
    wifiChannel5: null,
    avgWifiSignalDbm,
  };

  const { proposals } = detectCausesAndProposals(metrics);
  const proposal = proposals.find((p) => p.id === input.remediationId);

  if (!proposal) {
    throw ApiError.validation(
      `Remediación '${input.remediationId}' no encontrada en el análisis actual de la sesión.`,
    );
  }

  // Guardar estado previo (reversión)
  let previousState: Record<string, unknown> | null = null;
  if (proposal.reversible) {
    try {
      if (proposal.action === 'SET_CHANNEL' || proposal.action === 'REBOOT') {
        const wifiConfig = await withConnectorAudit(
          { connector: 'acs', operation: 'getWifiConfig', accountNumber, actorId: userId },
          () => acs.getWifiConfig(accountNumber),
          { accountNumber },
        );
        previousState = { wifiConfig: wifiConfig as unknown as Record<string, unknown> };
      }
    } catch {
      // No bloquear si no se puede guardar el estado previo; se loguea
      logger.warn(
        { sessionId, remediationId: input.remediationId },
        'Auto-asistencia: no se pudo guardar estado previo para reversión',
      );
    }
  }

  // Crear RemoteAction en BD (PENDING)
  const dbAction = await assistanceRepository.createRemoteAction({
    sessionId,
    accountNumber,
    action: proposal.action,
    request: {
      remediationId: proposal.id,
      cause: proposal.cause,
      params: proposal.params,
      previousState: previousState ?? null,
    },
    performedBy: userId,
  });

  await assistanceRepository.createEvent({
    sessionId,
    type: 'ACTION',
    payload: {
      actionId: dbAction.id,
      actionType: 'AUTO_ASSIST',
      remediationId: proposal.id,
      cause: proposal.cause,
      params: proposal.params,
    },
    actorId: userId,
  });

  // Ejecutar la remediación (síncrono para poder devolver 502 al llamador)
  try {
    await executeRemediationAction(acs, accountNumber, proposal, userId);

    const updated = await assistanceRepository.updateRemoteActionResult(dbAction.id, 'SUCCESS', {
      remediationId: proposal.id,
      applied: true,
      previousState: previousState ?? null,
    });
    broadcastActionResult(sessionId, mapRemoteAction(updated));

    // Evento de éxito
    await assistanceRepository.createEvent({
      sessionId,
      type: 'ACTION',
      payload: {
        actionId: dbAction.id,
        result: 'SUCCESS',
        remediationId: proposal.id,
      },
      actorId: userId,
    });

    return {
      remediationId: proposal.id,
      action: proposal.action,
      status: 'APPLIED',
      message: `Remediación aplicada correctamente: ${proposal.description}`,
      previousState,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Error desconocido al aplicar remediación.';

    const updated = await assistanceRepository.updateRemoteActionResult(dbAction.id, 'FAILED', {
      remediationId: proposal.id,
      error: errMsg,
    });
    broadcastActionResult(sessionId, mapRemoteAction(updated));

    // El error del conector se propaga como 502
    throw ApiError.connectorError(
      `No se pudo aplicar la remediación '${proposal.id}': ${errMsg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ejecutor de acciones (delega en el conector ACS)
// ---------------------------------------------------------------------------

async function executeRemediationAction(
  acs: ReturnType<typeof getAcsConnector>,
  accountNumber: string,
  proposal: ProposedRemediation,
  actorId: string,
): Promise<void> {
  switch (proposal.action) {
    case 'SET_CHANNEL': {
      const p = proposal.params as { band: WifiBand; channel: number };
      await withConnectorAudit(
        { connector: 'acs', operation: 'setChannel', accountNumber, actorId },
        () => acs.setChannel(accountNumber, { band: p.band, channel: p.channel }),
        { accountNumber, band: p.band, channel: p.channel },
      );
      break;
    }
    case 'REPROVISION': {
      await withConnectorAudit(
        { connector: 'acs', operation: 'reprovision', accountNumber, actorId },
        () => acs.reprovision(accountNumber),
        { accountNumber },
      );
      break;
    }
    case 'REBOOT': {
      await withConnectorAudit(
        { connector: 'acs', operation: 'reboot', accountNumber, actorId },
        () => acs.reboot(accountNumber),
        { accountNumber },
      );
      break;
    }
    case 'FACTORY_RESET': {
      await withConnectorAudit(
        { connector: 'acs', operation: 'factoryReset', accountNumber, actorId },
        () => acs.factoryReset(accountNumber),
        { accountNumber },
      );
      break;
    }
    default: {
      throw new Error(`Acción de remediación no soportada: ${proposal.action as string}`);
    }
  }
}
