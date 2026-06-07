/**
 * Servicio de estudio agregado — GET /sessions/{id}/study (Fase F).
 *
 * Reutiliza datos de /herramientas/v1 (NO reimplementa el diagnóstico):
 * - Último heatmap por accountNumber → heatmapRepository
 * - Último speedtest  → speedtestRepository
 * - Últimos pings     → pingRepository
 * - Dispositivos LAN/WiFi → ACS connector
 * - Telemetría de planta  → ispmonitor.getPlantTelemetry (auditado)
 */

import pino from 'pino';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../middleware/error-handler.js';
import { getIspMonitorConnector } from '../../connectors/ispmonitor/index.js';
import { getAcsConnector } from '../../connectors/acs/index.js';
import { withConnectorAudit } from '../../connectors/connector-audit.js';
import type { StudyOverviewDto } from './assistance.mappers.js';
import { assistanceRepository } from './assistance.repository.js';
import { env } from '../../config/env.js';

const logger = pino({ name: 'study.service', level: env.LOG_LEVEL });

// ---------------------------------------------------------------------------
// Helpers de consulta de herramientas (reúsa los repositorios existentes)
// ---------------------------------------------------------------------------

/** Último heatmap por accountNumber (directamente vía Prisma — NO duplica lógica). */
async function getLatestHeatmapId(accountNumber: string): Promise<string | null> {
  const heatmap = await prisma.wifiHeatmap.findFirst({
    where: { accountNumber },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return heatmap?.id ?? null;
}

/** Último speedtest por accountNumber. */
async function getLatestSpeedtest(
  accountNumber: string,
): Promise<{ downloadMbps: number; uploadMbps: number; measuredAt: string } | null> {
  const row = await prisma.speedtest.findFirst({
    where: { accountNumber },
    orderBy: { measuredAt: 'desc' },
    select: { downloadMbps: true, uploadMbps: true, measuredAt: true },
  });
  if (!row) return null;
  return {
    downloadMbps: row.downloadMbps,
    uploadMbps: row.uploadMbps,
    measuredAt: row.measuredAt.toISOString(),
  };
}

/** Últimos N pings por accountNumber (resumen: target + avg latencia + pérdida). */
async function getRecentPings(
  accountNumber: string,
  limit = 5,
): Promise<Array<{ target: string; avgLatencyMs: number | null; packetLossPercent: number | null }>> {
  const rows = await prisma.pingTest.findMany({
    where: { accountNumber },
    orderBy: { measuredAt: 'desc' },
    take: limit,
    select: { target: true, avgLatencyMs: true, packetLossPercent: true },
  });
  return rows.map((r) => ({
    target: r.target,
    avgLatencyMs: r.avgLatencyMs ?? null,
    packetLossPercent: r.packetLossPercent ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Función principal del servicio
// ---------------------------------------------------------------------------

export async function getStudyOverview(
  sessionId: string,
  userId: string,
  role: string,
): Promise<StudyOverviewDto> {
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

  // Recopilar todos los datos en paralelo — si alguno falla, devuelve null en ese campo
  const [
    latestHeatmapId,
    latestSpeedtest,
    pings,
    lanAndWifi,
    plant,
  ] = await Promise.allSettled([
    getLatestHeatmapId(accountNumber),
    getLatestSpeedtest(accountNumber),
    getRecentPings(accountNumber),
    // Dispositivos LAN y WiFi vía ACS (auditado)
    (async () => {
      const acs = getAcsConnector();
      const [lan, wifi] = await Promise.all([
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
      ]);
      return { lanCount: lan.length, wifiCount: wifi.length };
    })(),
    // Telemetría de planta vía ispmonitor (auditada)
    (async () => {
      const ispMonitor = getIspMonitorConnector();
      const t = await withConnectorAudit(
        { connector: 'ispmonitor', operation: 'getPlantTelemetry', accountNumber, actorId: userId },
        () => ispMonitor.getPlantTelemetry(accountNumber),
        { accountNumber },
      );
      return t;
    })(),
  ]);

  // Extraer valores con manejo seguro de PromiseSettledResult
  function settled<T>(result: PromiseSettledResult<T>, label: string): T | null {
    if (result.status === 'fulfilled') return result.value;
    logger.warn({ sessionId, field: label, err: result.reason }, 'Estudio: campo no disponible');
    return null;
  }

  const heatmapId = settled(latestHeatmapId, 'latestHeatmapId');
  const speedtest = settled(latestSpeedtest, 'latestSpeedtest');
  const pingsData = settled(pings, 'pings') ?? [];
  const devices = settled(lanAndWifi, 'devices');
  const plantTelemetry = settled(plant, 'plant');

  const dto: StudyOverviewDto = {
    accountNumber,
    latestHeatmapId: heatmapId,
    latestSpeedtest: speedtest,
    pings: pingsData,
    lanDeviceCount: devices?.lanCount ?? null,
    wifiDeviceCount: devices?.wifiCount ?? null,
    plant: plantTelemetry
      ? {
          onuRxPower: plantTelemetry.onuRxPower,
          snr: plantTelemetry.snr,
          source: plantTelemetry.source,
        }
      : null,
  };

  return dto;
}
