// Pruebas de la capa nueva de conectores hacia la API de operadora:
// firma Digest, normalización de ids y parseo tolerante de las respuestas.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDigestHeader, parseDigestChallenge } from '../../src/connectors/http/digest.js';
import { normalizeTerminalId } from '../../src/connectors/http/tec-api.js';
import { mapNapRow } from '../../src/connectors/tec/index.js';
import {
  normalizeSeries,
  toIsoDate,
  toNumber,
  toBoolish,
  flattenFields,
  findField,
} from '../../src/connectors/ispmonitor/normalize.js';

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

describe('Digest (RFC 2617) — challenge y firma', () => {
  const header =
    'Digest realm="tec.grupotvcable.com", qop="auth", nonce="746563323338", opaque="6D7963617070"';

  it('parsea el challenge real de la API de operadora', () => {
    const challenge = parseDigestChallenge(header);
    expect(challenge).toEqual({
      realm: 'tec.grupotvcable.com',
      qop: 'auth',
      nonce: '746563323338',
      opaque: '6D7963617070',
    });
  });

  it('ignora cabeceras que no son Digest', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
  });

  it('calcula el response MD5 con qop=auth según la fórmula del RFC', () => {
    const challenge = { ...parseDigestChallenge(header)!, nc: 1 };
    const creds = { username: 'usuario-demo', password: 'secreto' };
    const uri = '/api/tec/naps/-2.1,-79.9';
    const cnonce = '0123456789abcdef';

    const value = buildDigestHeader(creds, challenge, 'GET', uri, cnonce);

    const ha1 = md5(`${creds.username}:${challenge.realm}:${creds.password}`);
    const ha2 = md5(`GET:${uri}`);
    const expected = md5(`${ha1}:${challenge.nonce}:00000001:${cnonce}:auth:${ha2}`);

    expect(value).toContain(`response="${expected}"`);
    expect(value).toContain('qop=auth');
    expect(value).toContain('nc=00000001');
    expect(value).toContain(`uri="${uri}"`);
    expect(value).toContain('opaque="6D7963617070"');
  });

  it('usa la fórmula sin qop cuando el servidor no lo anuncia', () => {
    const challenge = { realm: 'r', nonce: 'n', nc: 1 };
    const value = buildDigestHeader({ username: 'u', password: 'p' }, challenge, 'GET', '/x', 'cn');
    const expected = md5(`${md5('u:r:p')}:n:${md5('GET:/x')}`);
    expect(value).toContain(`response="${expected}"`);
    expect(value).not.toContain('qop=');
  });
});

describe('normalizeTerminalId', () => {
  it('acepta un serial GPON y lo pasa a mayúsculas', () => {
    expect(normalizeTerminalId('hwtc1234abcd')).toBe('HWTC1234ABCD');
  });

  it('convierte una MAC con separadores a hex plano (IIS rechaza ":")', () => {
    expect(normalizeTerminalId('a4:b8:7e:11:22:33')).toBe('A4B87E112233');
    expect(normalizeTerminalId('A4-B8-7E-11-22-33')).toBe('A4B87E112233');
  });

  it('rechaza vacío y caracteres peligrosos en la ruta', () => {
    expect(() => normalizeTerminalId('')).toThrow();
    expect(() => normalizeTerminalId('../../etc/passwd')).toThrow();
  });
});

describe('mapNapRow — respuesta real de /api/tec/naps', () => {
  it('mapea la fila que devuelve la operadora', () => {
    const row = { nap: 'PL2KD9', lat: -2.168419, lng: -79.918913, distance: 20.0, ports: 8, used: 4 };
    expect(mapNapRow(row)).toEqual({
      // TEC no expone id numérico ni red de acceso: ambos van en null y
      // `source` deja explícito de dónde salió la fila.
      napId: null,
      napCode: 'PL2KD9',
      networkName: null,
      latitude: -2.168419,
      longitude: -79.918913,
      distanceMeters: 20,
      occupiedPorts: 4,
      totalPorts: 8,
      freePorts: 4,
      source: 'TEC',
    });
  });

  it('descarta filas sin código de NAP', () => {
    expect(mapNapRow({ lat: 1, lng: 2 })).toBeNull();
    expect(mapNapRow('PL2KD9')).toBeNull();
  });
});

describe('normalizeSeries — formatos tolerados', () => {
  it('array de objetos con fecha ISO y varias métricas', () => {
    const raw = [
      { date: '2026-08-26T10:00:00Z', snrDown: 35.2, snrUp: 30.1 },
      { date: '2026-08-26T09:00:00Z', snrDown: 34.8, snrUp: 29.9 },
    ];
    const series = normalizeSeries(raw);
    expect(series.recognized).toBe(true);
    expect(series.keys.sort()).toEqual(['snrDown', 'snrUp']);
    // Se ordena cronológicamente ascendente.
    expect(series.points[0]!.t).toBe('2026-08-26T09:00:00.000Z');
    expect(series.points[1]!.values.snrDown).toBe(35.2);
  });

  it('objeto contenedor con el array dentro de "data"', () => {
    const series = normalizeSeries({ data: [{ fecha: '26/08/2026 08:00', valor: '12,5' }] });
    expect(series.recognized).toBe(true);
    expect(series.keys).toEqual(['valor']);
    expect(series.points[0]!.values.valor).toBe(12.5);
  });

  it('array de escalares', () => {
    const series = normalizeSeries([1, 0, 1, 1]);
    expect(series.keys).toEqual(['value']);
    expect(series.points).toHaveLength(4);
  });

  it('array vacío y null se consideran "sin datos", no formato desconocido', () => {
    expect(normalizeSeries([]).recognized).toBe(true);
    expect(normalizeSeries(null).recognized).toBe(true);
  });

  it('formato irreconocible conserva el payload crudo', () => {
    const raw = { mensaje: 'sin datos' };
    const series = normalizeSeries(raw);
    expect(series.recognized).toBe(false);
    expect(series.raw).toBe(raw);
  });
});

describe('Helpers de parseo', () => {
  it('toNumber acepta coma decimal y rechaza texto', () => {
    expect(toNumber('12,5')).toBe(12.5);
    expect(toNumber('-3.2')).toBe(-3.2);
    expect(toNumber('PL2KD9')).toBeNull();
    expect(toNumber(true)).toBe(1);
  });

  it('toIsoDate entiende ISO, dd/MM/yyyy y /Date(ms)/ de ASP.NET', () => {
    expect(toIsoDate('2026-08-26T10:00:00Z')).toBe('2026-08-26T10:00:00.000Z');
    expect(toIsoDate('/Date(1756209600000)/')).toBe(new Date(1756209600000).toISOString());
    expect(toIsoDate('26/08/2026 08:30')).not.toBeNull();
    expect(toIsoDate('PL2KD9')).toBeNull();
  });

  it('toBoolish entiende estados en texto', () => {
    expect(toBoolish('ONLINE')).toBe(true);
    expect(toBoolish('Offline')).toBe(false);
    expect(toBoolish(1)).toBe(true);
    expect(toBoolish('quizás')).toBeNull();
  });

  it('flattenFields + findField localizan campos anidados con alias laxos', () => {
    const fields = flattenFields({
      estadoEquipo: 'ONLINE',
      evento: { activo: true, descripcion: 'Corte de fibra' },
    });
    expect(findField(fields, ['estadoequipo'])?.value).toBe('ONLINE');
    expect(findField(fields, ['descripcion'])?.path).toBe('evento.descripcion');
  });
});
