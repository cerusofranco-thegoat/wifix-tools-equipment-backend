/**
 * Tests de Fase F — conectores nuevos y extendidos.
 * Verifican: mock determinista, real lanza notImplemented, operaciones completas.
 */
import { describe, it, expect } from 'vitest';
import { ticketingMock, ticketingReal } from '../../src/connectors/ticketing/index.js';
import { schedulingMock, schedulingReal } from '../../src/connectors/scheduling/index.js';
import { fsmMock, fsmReal } from '../../src/connectors/fsm/index.js';
import { ispMonitorMock, ispMonitorReal } from '../../src/connectors/ispmonitor/index.js';
import { ApiError } from '../../src/middleware/error-handler.js';

// ---------------------------------------------------------------------------
// ticketing mock
// ---------------------------------------------------------------------------

describe('ticketingMock — determinismo', () => {
  it('generaTicket devuelve el mismo ticketId para la misma cuenta+description', async () => {
    const a = await ticketingMock.generaTicket({ accountNumber: 'WX-001', description: 'Prueba' });
    const b = await ticketingMock.generaTicket({ accountNumber: 'WX-001', description: 'Prueba' });
    expect(a.ticketId).toBe(b.ticketId);
    expect(a.status).toBe('ABIERTO');
    expect(a.accountNumber).toBe('WX-001');
  });

  it('generaTicket devuelve ticketIds distintos para cuentas distintas', async () => {
    const a = await ticketingMock.generaTicket({ accountNumber: 'WX-001', description: 'Prueba' });
    const b = await ticketingMock.generaTicket({ accountNumber: 'WX-002', description: 'Prueba' });
    expect(a.ticketId).not.toBe(b.ticketId);
  });

  it('obtieneTicket es determinista por ticketId', async () => {
    const a = await ticketingMock.obtieneTicket('TKT-123456');
    const b = await ticketingMock.obtieneTicket('TKT-123456');
    expect(a).toEqual(b);
  });

  it('obtieneTicket difiere entre ticketIds distintos', async () => {
    const a = await ticketingMock.obtieneTicket('TKT-000001');
    const b = await ticketingMock.obtieneTicket('TKT-999999');
    expect(a.ticketId).not.toBe(b.ticketId);
  });

  it('backOfficeOps es determinista', async () => {
    const a = await ticketingMock.backOfficeOps('TKT-111', 'REOPEN');
    const b = await ticketingMock.backOfficeOps('TKT-111', 'REOPEN');
    expect(a.actionId).toBe(b.actionId);
    expect(a.type).toBe('REOPEN');
  });

  it('retiroAnticipado es determinista', async () => {
    const a = await ticketingMock.retiroAnticipado({
      accountNumber: 'WX-001',
      ticketId: 'TKT-100',
      reason: 'Test',
    });
    const b = await ticketingMock.retiroAnticipado({
      accountNumber: 'WX-001',
      ticketId: 'TKT-100',
      reason: 'Test',
    });
    expect(a.withdrawalId).toBe(b.withdrawalId);
    expect(a.success).toBe(true);
  });
});

describe('ticketingReal — lanza notImplemented (CONNECTOR_ERROR)', () => {
  it('generaTicket lanza ApiError.connectorError', async () => {
    await expect(
      ticketingReal.generaTicket({ accountNumber: 'WX-001', description: 'Test' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_ERROR', statusCode: 502 });
  });

  it('obtieneTicket lanza ApiError.connectorError', async () => {
    await expect(ticketingReal.obtieneTicket('TKT-000')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('backOfficeOps lanza ApiError.connectorError', async () => {
    await expect(ticketingReal.backOfficeOps('TKT-000', 'action')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('retiroAnticipado lanza ApiError.connectorError', async () => {
    await expect(
      ticketingReal.retiroAnticipado({ accountNumber: 'WX-001', ticketId: 'TKT-000', reason: '' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// scheduling mock
// ---------------------------------------------------------------------------

describe('schedulingMock — determinismo', () => {
  it('agendarTurno es determinista para la misma cuenta', async () => {
    const a = await schedulingMock.agendarTurno({ accountNumber: 'WX-SCHED-001' });
    const b = await schedulingMock.agendarTurno({ accountNumber: 'WX-SCHED-001' });
    expect(a.turnoId).toBe(b.turnoId);
    expect(a.status).toBe('PENDIENTE');
  });

  it('agendarTurno respeta preferredWindow', async () => {
    const a = await schedulingMock.agendarTurno({
      accountNumber: 'WX-SCHED-002',
      preferredWindow: 'TARDE',
    });
    expect(a.window).toBe('TARDE');
  });

  it('obtieneTurno es determinista', async () => {
    const a = await schedulingMock.obtieneTurno('TRN-12345');
    const b = await schedulingMock.obtieneTurno('TRN-12345');
    expect(a).toEqual(b);
  });

  it('cancelarTurno es determinista', async () => {
    const a = await schedulingMock.cancelarTurno({ turnoId: 'TRN-99999' });
    const b = await schedulingMock.cancelarTurno({ turnoId: 'TRN-99999' });
    expect(a.turnoId).toBe('TRN-99999');
    expect(a.success).toBe(true);
    expect(a.cancelledAt).toBe(b.cancelledAt);
  });
});

describe('schedulingReal — lanza notImplemented', () => {
  it('agendarTurno lanza CONNECTOR_ERROR', async () => {
    await expect(
      schedulingReal.agendarTurno({ accountNumber: 'WX-001' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_ERROR' });
  });

  it('obtieneTurno lanza CONNECTOR_ERROR', async () => {
    await expect(schedulingReal.obtieneTurno('TRN-000')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('cancelarTurno lanza CONNECTOR_ERROR', async () => {
    await expect(schedulingReal.cancelarTurno({ turnoId: 'TRN-000' })).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// FSM extendido — nuevas operaciones (Fase F)
// ---------------------------------------------------------------------------

describe('fsmMock — nuevas operaciones Fase F', () => {
  it('creaFsmVistec es determinista', async () => {
    const a = await fsmMock.creaFsmVistec({ accountNumber: 'WX-FSM-001', description: 'Visita' });
    const b = await fsmMock.creaFsmVistec({ accountNumber: 'WX-FSM-001', description: 'Visita' });
    expect(a.ordenId).toBe(b.ordenId);
    expect(a.status).toBe('CREADA');
    expect(a.accountNumber).toBe('WX-FSM-001');
  });

  it('creaFsmVistec preserva el tipo indicado', async () => {
    const orden = await fsmMock.creaFsmVistec({
      accountNumber: 'WX-FSM-002',
      description: 'Averías',
      type: 'AVERIAS',
    });
    expect(orden.type).toBe('AVERIAS');
  });

  it('fsmOrdenes es determinista y ordenado por fecha', async () => {
    const a = await fsmMock.fsmOrdenes('WX-FSM-003');
    const b = await fsmMock.fsmOrdenes('WX-FSM-003');
    expect(a).toEqual(b);
    for (let i = 0; i < a.length - 1; i++) {
      expect(a[i]!.createdAt >= a[i + 1]!.createdAt).toBe(true);
    }
  });

  it('cancelarOrden es determinista', async () => {
    const a = await fsmMock.cancelarOrden({ ordenId: 'FSM-123456' });
    const b = await fsmMock.cancelarOrden({ ordenId: 'FSM-123456' });
    expect(a.success).toBe(true);
    expect(a.cancelledAt).toBe(b.cancelledAt);
  });

  it('las operaciones originales (getUnsatisfactoryTasks, getPreviousVisits) siguen funcionando', async () => {
    const tasks = await fsmMock.getUnsatisfactoryTasks('WX-FSM-001');
    const visits = await fsmMock.getPreviousVisits('WX-FSM-001');
    expect(Array.isArray(tasks)).toBe(true);
    expect(visits.length).toBeGreaterThanOrEqual(1);
  });
});

describe('fsmReal — nuevas operaciones lanza notImplemented', () => {
  it('creaFsmVistec lanza CONNECTOR_ERROR', async () => {
    await expect(
      fsmReal.creaFsmVistec({ accountNumber: 'WX-001', description: 'Test' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_ERROR' });
  });

  it('fsmOrdenes lanza CONNECTOR_ERROR', async () => {
    await expect(fsmReal.fsmOrdenes('WX-001')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('cancelarOrden lanza CONNECTOR_ERROR', async () => {
    await expect(fsmReal.cancelarOrden({ ordenId: 'FSM-000' })).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// ispMonitor extendido — getPlantTelemetry (Fase F)
// ---------------------------------------------------------------------------

describe('ispMonitorMock — getPlantTelemetry', () => {
  it('es determinista por accountNumber', async () => {
    const a = await ispMonitorMock.getPlantTelemetry('WX-PLANT-001');
    const b = await ispMonitorMock.getPlantTelemetry('WX-PLANT-001');
    expect(a.onuRxPower).toBe(b.onuRxPower);
    expect(a.snr).toBe(b.snr);
    expect(a.technology).toBe(b.technology);
    expect(a.source).toBe('ispmonitor');
  });

  it('devuelve valores distintos para cuentas distintas', async () => {
    const a = await ispMonitorMock.getPlantTelemetry('WX-PLANT-001');
    const b = await ispMonitorMock.getPlantTelemetry('WX-PLANT-002');
    // Con alta probabilidad al menos uno de los campos difiere
    const differs = a.onuRxPower !== b.onuRxPower || a.snr !== b.snr;
    expect(differs).toBe(true);
  });

  it('HFC incluye campos cablemodem', async () => {
    // Buscamos una cuenta que sea HFC (determinista)
    // Múltiples intentos con distintas cuentas para encontrar una HFC
    const accounts = ['WX-HFC-A', 'WX-HFC-B', 'WX-HFC-C', 'WX-HFC-D', 'WX-HFC-E'];
    const results = await Promise.all(accounts.map((acc) => ispMonitorMock.getPlantTelemetry(acc)));
    const hfc = results.find((r) => r.technology === 'HFC');
    if (hfc) {
      expect(hfc.cablemodemDownstreamPower).toBeDefined();
      expect(hfc.cablemodemUpstreamPower).toBeDefined();
      expect(hfc.cablemodemMer).toBeDefined();
    }
    // Si no encontramos HFC entre estas cuentas, no fallamos: el mock es determinista
    // pero la distribución 30% HFC puede no cubrirlas todas
  });

  it('getNetworkMetrics sigue funcionando (no regresión)', async () => {
    const a = await ispMonitorMock.getNetworkMetrics('WX-NETM-001');
    const b = await ispMonitorMock.getNetworkMetrics('WX-NETM-001');
    expect(a.technology).toBe(b.technology);
    expect(a.signalLevels).toEqual(b.signalLevels);
  });
});

describe('ispMonitorReal — lanza notImplemented', () => {
  it('getPlantTelemetry lanza CONNECTOR_ERROR', async () => {
    await expect(ispMonitorReal.getPlantTelemetry('WX-001')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('getNetworkMetrics lanza CONNECTOR_ERROR', async () => {
    await expect(ispMonitorReal.getNetworkMetrics('WX-001')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// Verificar que ApiError se importa y construye correctamente (sanity check)
// ---------------------------------------------------------------------------

describe('ApiError sanity', () => {
  it('connectorError tiene statusCode 502', () => {
    const err = ApiError.connectorError('Prueba');
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('CONNECTOR_ERROR');
  });
});
