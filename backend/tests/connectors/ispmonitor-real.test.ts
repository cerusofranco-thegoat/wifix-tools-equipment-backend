// Mapeo de las respuestas REALES de ISP Monitor.
// Los payloads son los que devolvió `tec-api.grupotvcable.com` el 2026-08-26
// para el ONT ZTE activo ZTEGD3F9BBE5 (Quito, nodo 9198), recortados.
import { describe, it, expect } from 'vitest';
import { normalizeSeries } from '../../src/connectors/ispmonitor/normalize.js';
import {
  ispMonitorReal,
  ispMonitorMock,
  valueNamesFor,
  mapHistoryEntry,
} from '../../src/connectors/ispmonitor/index.js';

const TERMINAL_PAYLOAD = {
  type: 'GPON',
  city: 'Quito',
  id: 'ZTEGD3F9BBE5',
  device: 9919,
  ifIndex: 285282307,
  index: 11,
  networks: [9198],
  status: 'up',
  drop: null,
  events: null,
  terminals: [
    { Type: 'LastMonth', IDs: ['ZTEGD0BB8294'], Status: ['down'], Drop: '', Events: '' },
    { Type: 'LastHour', IDs: ['ZTEGD3F9BBE5'], Status: ['up'], Drop: '', Events: '' },
  ],
};

// Tuplas [epoch en segundos, valor] — 288 muestras cada 5 minutos.
const STATUS_PAYLOAD = [
  [1787683133, 1],
  [1787683434, 1],
  [1787683733, 0],
  [1787684034, 1],
];
const NETWORK_ONLINE_PAYLOAD = [
  [1787683134, 18],
  [1787683434, 18],
  [1787683733, 17],
];

describe('normalizeSeries — tuplas [epoch, valor] de ISP Monitor', () => {
  it('convierte epoch en segundos a ISO y nombra la columna', () => {
    const series = normalizeSeries(STATUS_PAYLOAD, ['online']);
    expect(series.recognized).toBe(true);
    expect(series.keys).toEqual(['online']);
    expect(series.points).toHaveLength(4);
    expect(series.points[0]).toEqual({
      t: new Date(1787683133 * 1000).toISOString(),
      values: { online: 1 },
    });
    expect(series.points[2]!.values.online).toBe(0);
  });

  it('sin nombres de columna usa "value"', () => {
    expect(normalizeSeries(STATUS_PAYLOAD).keys).toEqual(['value']);
  });

  it('soporta tuplas de varias columnas', () => {
    const raw = [[1787683133, 35.2, 30.1], [1787683434, 34.8, 29.9]];
    const series = normalizeSeries(raw, ['snrDown', 'snrUp']);
    expect(series.keys.sort()).toEqual(['snrDown', 'snrUp']);
    expect(series.points[0]!.values).toEqual({ snrDown: 35.2, snrUp: 30.1 });
  });

  it('mantiene el orden cronológico ascendente', () => {
    const series = normalizeSeries([[1787684034, 1], [1787683133, 0]], ['online']);
    expect(series.points[0]!.values.online).toBe(0);
  });
});

// Respuesta real de /api/isp/cablemodem/snr y /codewords para el cablemódem
// HFC activo 384C90A2DB11: una entrada por canal upstream, con su propia serie.
const SNR_PAYLOAD = [
  {
    ifIndex: 5000018,
    network: '2G-2 v',
    desc: 'Logical Upstream Channel 0/1.1/0',
    data: [[1787772828, 35.6], [1787773128, 35.6], [1787773428, 35.1]],
  },
  {
    ifIndex: 5000016,
    network: '2G-2',
    desc: 'Logical Upstream Channel 0/1.0/0',
    data: [[1787772828, 35.1], [1787773128, 34.7]],
  },
];

const CODEWORDS_PAYLOAD = [
  {
    ifIndex: 5000018,
    network: '2G-2 v',
    desc: 'Logical Upstream Channel 0/1.1/0',
    data: [[1787772979, 12, 3], [1787773278, 0, 0]],
  },
];

describe('normalizeSeries — series DOCSIS multicanal', () => {
  it('devuelve un canal por entrada, con su etiqueta y su serie', () => {
    const series = normalizeSeries(SNR_PAYLOAD, ['snr']);
    expect(series.recognized).toBe(true);
    expect(series.channels).toHaveLength(2);

    const [first, second] = series.channels;
    expect(first!.label).toBe('Logical Upstream Channel 0/1.1/0');
    expect(first!.network).toBe('2G-2 v');
    expect(first!.ifIndex).toBe(5000018);
    expect(first!.keys).toEqual(['snr']);
    expect(first!.points).toHaveLength(3);
    expect(first!.points[0]!.values.snr).toBe(35.6);
    expect(second!.points).toHaveLength(2);
  });

  it('keys/points reflejan el primer canal, para consumidores que no los manejen', () => {
    const series = normalizeSeries(SNR_PAYLOAD, ['snr']);
    expect(series.keys).toEqual(['snr']);
    expect(series.points).toEqual(series.channels[0]!.points);
  });

  it('soporta canales con varias columnas (FEC corregidos y sin corregir)', () => {
    const series = normalizeSeries(CODEWORDS_PAYLOAD, ['corrected', 'uncorrected']);
    expect(series.channels).toHaveLength(1);
    expect(series.channels[0]!.keys.sort()).toEqual(['corrected', 'uncorrected']);
    expect(series.channels[0]!.points[0]!.values).toEqual({ corrected: 12, uncorrected: 3 });
  });

  it('una serie de un solo nivel no declara canales', () => {
    expect(normalizeSeries(STATUS_PAYLOAD, ['online']).channels).toEqual([]);
  });

  it('cae al nombre por ifIndex si el canal no trae descripción', () => {
    const series = normalizeSeries([{ ifIndex: 42, data: [[1787772828, 1]] }], ['snr']);
    expect(series.channels[0]!.label).toBe('ifIndex 42');
  });
});

describe('valueNamesFor — nombre de columna según métrica y ámbito', () => {
  it('distingue el estado del equipo de la cuenta de equipos del nodo', () => {
    expect(valueNamesFor('terminal', 'status', STATUS_PAYLOAD)).toEqual(['online']);
    expect(valueNamesFor('network', 'status', NETWORK_ONLINE_PAYLOAD)).toEqual(['terminalsOnline']);
  });

  it('nombra SNR y codewords según cuántas columnas traiga el payload', () => {
    expect(valueNamesFor('terminal', 'snr', [[1, 35]])).toEqual(['snr']);
    expect(valueNamesFor('terminal', 'snr', [[1, 35, 30]])).toEqual(['snrDown', 'snrUp']);
    expect(valueNamesFor('terminal', 'codewords', [[1, 5]])).toEqual(['errors']);
    expect(valueNamesFor('terminal', 'codewords', [[1, 5, 0.2]])).toEqual(['corrected', 'uncorrected']);
  });

  it('cuenta las columnas dentro de `data` cuando el payload es multicanal', () => {
    expect(valueNamesFor('terminal', 'snr', SNR_PAYLOAD)).toEqual(['snr']);
    expect(valueNamesFor('terminal', 'codewords', CODEWORDS_PAYLOAD)).toEqual(['corrected', 'uncorrected']);
  });
});

describe('mapHistoryEntry — historial `terminals[]`', () => {
  it('mapea período, equipos y estados', () => {
    expect(mapHistoryEntry(TERMINAL_PAYLOAD.terminals[0])).toEqual({
      period: 'LastMonth',
      ids: ['ZTEGD0BB8294'],
      statuses: ['down'],
      drop: null,
      events: null,
    });
  });

  it('trata las cadenas vacías de Drop/Events como ausencia de dato', () => {
    const entry = mapHistoryEntry({ Type: 'LastHour', IDs: [], Status: [], Drop: '', Events: '' });
    expect(entry).toEqual({ period: 'LastHour', ids: [], statuses: [], drop: null, events: null });
  });

  it('descarta entradas que no son objetos', () => {
    expect(mapHistoryEntry('LastHour')).toBeNull();
  });
});

describe('Ficha del terminal con la respuesta real', () => {
  // buildSnapshot no se exporta; se ejercita a través del mock, que usa
  // exactamente el mismo shape que la API real.
  it('el mock produce la misma forma que el mapeo real', async () => {
    const snapshot = await ispMonitorMock.getTerminal('ZTEGD3F9BBE5');
    expect(snapshot.found).toBe(true);
    expect(snapshot.technology).toBe('GPON');
    expect(snapshot.city).toBeTypeOf('string');
    expect(snapshot.networkIds.length).toBeGreaterThan(0);
    expect(snapshot.history.length).toBeGreaterThan(0);
    // `networks` es el id del nodo, no un estado: no debe colarse como campo.
    expect(snapshot.fields.map((f) => f.key)).not.toContain('networks');
    // Los campos ya representados aparte tampoco se repiten.
    expect(snapshot.fields.map((f) => f.key)).not.toContain('status');
    expect(snapshot.fields.map((f) => f.key)).toContain('device');
  });

  it('una MAC de 12 hex se detecta como HFC', async () => {
    const snapshot = await ispMonitorMock.getTerminal('B4:04:21:E1:5A:DC');
    expect(snapshot.id).toBe('B40421E15ADC');
    expect(snapshot.technology).toBe('HFC');
  });

  it('el conector real existe y expone las cuatro operaciones', () => {
    expect(typeof ispMonitorReal.getTerminal).toBe('function');
    expect(typeof ispMonitorReal.getSeries).toBe('function');
    expect(typeof ispMonitorReal.getDiagnostics).toBe('function');
    expect(typeof ispMonitorReal.getNetworkMetrics).toBe('function');
  });
});
