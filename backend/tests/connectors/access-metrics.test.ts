// Métricas por tecnología (DOCSIS / GPON) y caídas con hora exacta.
// Sin red: las series "reales" se construyen con payloads del mismo formato
// que devolvió tec-api (tuplas [epoch, valor] cada 5 min).
import { describe, it, expect } from 'vitest';
import { normalizeSeries } from '../../src/connectors/ispmonitor/normalize.js';
import {
  deriveOutages,
  technologyFromIdFormat,
  toLocalIso,
} from '../../src/connectors/ispmonitor/access-metrics.js';
import {
  applyTechnologyHint,
  enrichDiagnostics,
  ispMonitorMock,
  type Series24h,
  type TerminalSnapshot,
} from '../../src/connectors/ispmonitor/index.js';

const T0 = Date.parse('2026-09-30T12:00:00.000Z') / 1000;
const STEP = 300;

/** Serie de estado real-like: 1 = en línea, 0 = caído. */
function statusSeries(values: number[]): Series24h {
  const raw = values.map((v, i) => [T0 + i * STEP, v]);
  return {
    id: 'ZTEGD3F9BBE5',
    scope: 'terminal',
    metric: 'status',
    ...normalizeSeries(raw, ['online']),
    fetchedAt: new Date((T0 + values.length * STEP) * 1000).toISOString(),
  };
}

function snapshot(extra: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: 'ZTEGD3F9BBE5',
    found: true,
    online: true,
    technology: 'GPON',
    technologySource: 'ISP_MONITOR',
    city: 'Quito',
    networkIds: [9198],
    event: { active: false, description: null },
    drop: { detected: false, description: null },
    history: [],
    fields: [],
    raw: null,
    fetchedAt: new Date().toISOString(),
    ...extra,
  };
}

describe('toLocalIso', () => {
  it('convierte UTC a hora de Ecuador con offset explícito', () => {
    expect(toLocalIso('2026-09-30T13:15:00.000Z')).toBe('2026-09-30T08:15:00.000-05:00');
    expect(toLocalIso('2026-10-01T02:00:00.000Z')).toBe('2026-09-30T21:00:00.000-05:00');
  });
});

describe('technologyFromIdFormat', () => {
  it('serial de vendor → GPON; MAC 12-hex → HFC; otra cosa → null', () => {
    expect(technologyFromIdFormat('ZTEGD3F9BBE5')).toBe('GPON');
    expect(technologyFromIdFormat('HWTCCB48FAAA')).toBe('GPON');
    expect(technologyFromIdFormat('384C90A2DB11')).toBe('HFC');
    expect(technologyFromIdFormat('ABC')).toBeNull();
  });
});

describe('deriveOutages — serie real de ISP Monitor', () => {
  const now = new Date((T0 + 10 * STEP) * 1000);

  it('cada tramo en 0 es una caída con inicio, fin y duración exactos', () => {
    const { summary, uptime } = deriveOutages(statusSeries([1, 1, 0, 0, 0, 1, 1, 0, 1, 1]), {
      now,
      source: 'ISP_MONITOR',
      simulated: false,
    });
    expect(summary).toMatchObject({ source: 'ISP_MONITOR', causeSource: 'NONE', simulated: false, count: 2 });
    // La más reciente primero.
    expect(summary.items[0]).toMatchObject({
      startedAt: new Date((T0 + 7 * STEP) * 1000).toISOString(),
      endedAt: new Date((T0 + 8 * STEP) * 1000).toISOString(),
      durationSeconds: 300,
      ongoing: false,
      cause: 'UNKNOWN',
      precisionSeconds: 300,
      simulated: false,
    });
    expect(summary.items[1]).toMatchObject({
      startedAt: '2026-09-30T12:10:00.000Z',
      startedAtLocal: '2026-09-30T07:10:00.000-05:00',
      endedAt: '2026-09-30T12:25:00.000Z',
      endedAtLocal: '2026-09-30T07:25:00.000-05:00',
      durationSeconds: 900,
    });
    expect(summary.totalDownSeconds).toBe(1200);
    expect(uptime).toMatchObject({
      since: new Date((T0 + 8 * STEP) * 1000).toISOString(),
      seconds: 600,
      lowerBound: false,
    });
  });

  it('serie que termina caída → caída en curso y sin uptime', () => {
    const { summary, uptime } = deriveOutages(statusSeries([1, 1, 1, 0, 0]), {
      now: new Date((T0 + 5 * STEP) * 1000),
      source: 'ISP_MONITOR',
      simulated: false,
    });
    expect(summary.items[0]).toMatchObject({ ongoing: true, endedAt: null, durationSeconds: 600 });
    expect(uptime.seconds).toBeNull();
  });

  it('sin caídas → uptime es cota inferior (toda la ventana)', () => {
    const { summary, uptime } = deriveOutages(statusSeries([1, 1, 1]), {
      now: new Date((T0 + 3 * STEP) * 1000),
      source: 'ISP_MONITOR',
      simulated: false,
    });
    expect(summary.count).toBe(0);
    expect(uptime).toMatchObject({ seconds: 900, lowerBound: true });
  });

  it('sin serie → source NONE', () => {
    const { summary } = deriveOutages(null, { now, source: 'ISP_MONITOR', simulated: false });
    expect(summary).toMatchObject({ source: 'NONE', count: 0, items: [] });
  });
});

describe('enrichDiagnostics — modo real', () => {
  const series = statusSeries([1, 0, 0, 1]);
  const base = {
    id: 'ZTEGD3F9BBE5',
    status: { terminal: series, network: null },
    snr: { terminal: null, network: null },
    codewords: { terminal: null, network: null },
    errors: [],
    skipped: [],
    window: { hours: 24 as const, until: series.fetchedAt },
    fetchedAt: series.fetchedAt,
  };

  it('GPON: bloque óptico simulado, sin DOCSIS, caídas reales sin causa', () => {
    const d = enrichDiagnostics({ ...base, terminal: snapshot() }, false);
    expect(d.technology).toBe('GPON');
    expect(d.technologySource).toBe('ISP_MONITOR');
    expect(d.simulated).toBe(false);
    expect(d.docsis).toBeNull();
    expect(d.gpon).not.toBeNull();
    expect(d.gpon?.simulated).toBe(true);
    expect(d.gpon?.sources).toEqual({
      optical: 'SIMULATED',
      onuState: 'ISP_MONITOR',
      accessNetwork: 'ISP_MONITOR',
      oltTopology: 'SIMULATED',
    });
    expect(d.gpon?.olt.accessNetworkIds).toEqual([9198]);
    expect(d.gpon?.onu.state).toBe('ONLINE');
    expect(d.gpon?.optical.rxPowerDbm).toBeLessThan(-8);
    expect(d.outages).toMatchObject({ source: 'ISP_MONITOR', simulated: false, count: 1 });
    expect(d.outages.items[0]?.cause).toBe('UNKNOWN');
  });

  it('HFC: bloque DOCSIS con SNR/FEC reales por canal y potencias simuladas', () => {
    const snrRaw = [
      { ifIndex: 5000016, network: '2G-2', desc: 'Logical Upstream Channel 0/1.0/0', data: [[T0, 35.1], [T0 + STEP, 36.2]] },
      { ifIndex: 5000018, network: '2G-2 v', desc: 'Logical Upstream Channel 0/1.1/0', data: [[T0, 33.0], [T0 + STEP, 34.0]] },
    ];
    const cwRaw = [[T0, 1.5, 0.02], [T0 + STEP, 2.0, 0.05]];
    const snr: Series24h = { id: '384C90A2DB11', scope: 'terminal', metric: 'snr', ...normalizeSeries(snrRaw, ['snr']), fetchedAt: series.fetchedAt };
    const codewords: Series24h = { id: '384C90A2DB11', scope: 'terminal', metric: 'codewords', ...normalizeSeries(cwRaw, ['corrected', 'uncorrected']), fetchedAt: series.fetchedAt };
    const d = enrichDiagnostics(
      {
        ...base,
        id: '384C90A2DB11',
        terminal: snapshot({ id: '384C90A2DB11', technology: 'HFC' }),
        snr: { terminal: snr, network: null },
        codewords: { terminal: codewords, network: null },
      },
      false,
    );
    expect(d.technology).toBe('HFC');
    expect(d.gpon).toBeNull();
    expect(d.docsis?.sources).toEqual({
      snrUpstream: 'ISP_MONITOR',
      snrDownstream: 'SIMULATED',
      power: 'SIMULATED',
      codewords: 'ISP_MONITOR',
    });
    expect(d.docsis?.upstream.channels.map((c) => [c.channelId, c.snrDb])).toEqual([
      ['5000016', 36.2],
      ['5000018', 34],
    ]);
    expect(d.docsis?.upstream.channels[0]?.simulatedFields).not.toContain('snrDb');
    expect(d.docsis?.codewords).toEqual({ correctedPercent: 2, uncorrectedPercent: 0.05 });
    expect(d.docsis?.downstream.channels).toHaveLength(4);
  });

  it('equipo no encontrado: technology null y sin bloques', () => {
    const d = enrichDiagnostics(
      { ...base, status: { terminal: null, network: null }, terminal: snapshot({ found: false, technology: null }) },
      false,
    );
    expect(d).toMatchObject({ technology: null, technologySource: 'UNKNOWN', docsis: null, gpon: null });
  });
});

describe('pista de tecnología (?technology=)', () => {
  it('la ficha con type explícito manda sobre la pista', () => {
    const t = applyTechnologyHint(snapshot(), 'HFC');
    expect(t).toMatchObject({ technology: 'GPON', technologySource: 'ISP_MONITOR' });
  });

  it('sin type explícito, la pista gana al formato del id', () => {
    const t = applyTechnologyHint(snapshot({ technology: 'HFC', technologySource: 'ID_FORMAT' }), 'GPON');
    expect(t).toMatchObject({ technology: 'GPON', technologySource: 'HINT' });
  });

  it('mock: la MAC de un ONT con ?technology=GPON sale como GPON, sin DOCSIS', async () => {
    const d = await ispMonitorMock.getDiagnostics('A4:B8:7E:11:22:33', { technology: 'GPON' });
    expect(d).toMatchObject({ technology: 'GPON', technologySource: 'HINT', simulated: true, docsis: null });
    expect(d.gpon).not.toBeNull();
    expect(d.snr.terminal).toBeNull();
    expect(d.skipped).toHaveLength(4);
  });
});

describe('mock — coherencia', () => {
  it('GPON: bloque óptico, caídas con causa LOS/dying gasp y hora local', async () => {
    const d = await ispMonitorMock.getDiagnostics('ZTEGD3F9BBE5');
    expect(d).toMatchObject({ technology: 'GPON', technologySource: 'ID_FORMAT', simulated: true, docsis: null });
    expect(d.status.terminal?.points).toHaveLength(288);
    for (const e of d.outages.items) {
      expect(['LOS', 'DYING_GASP']).toContain(e.cause);
      expect(e.startedAt).toMatch(/Z$/);
      expect(e.startedAtLocal).toMatch(/-05:00$/);
      expect(e.simulated).toBe(true);
    }
    // Estado de la ONU coherente con la ficha simulada.
    expect(d.gpon?.onu.state === 'ONLINE').toBe(d.terminal.online === true);
  });

  it('HFC: bloque DOCSIS y ninguna métrica óptica', async () => {
    const d = await ispMonitorMock.getDiagnostics('384C90A2DB11');
    expect(d.technology).toBe('HFC');
    expect(d.gpon).toBeNull();
    expect(d.docsis?.thresholds.upstreamSnrDbMin).toBe(27);
    // Si el cablemódem está caído, la caída en curso cierra la serie.
    const ongoing = d.outages.items.filter((e) => e.ongoing);
    expect(ongoing.length).toBe(d.terminal.online ? 0 : 1);
  });

  it('determinista por id', async () => {
    const a = await ispMonitorMock.getDiagnostics('ZTEGD3F9BBE5');
    const b = await ispMonitorMock.getDiagnostics('ZTEGD3F9BBE5');
    expect(a.gpon?.optical).toEqual(b.gpon?.optical);
    expect(a.outages.count).toBe(b.outages.count);
  });
});
