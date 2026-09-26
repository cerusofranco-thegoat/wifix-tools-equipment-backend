// Normalización de la whitelist — funciones puras. Datos 100 % sintéticos.
import { describe, it, expect } from 'vitest';
import {
  cleanText,
  csvLineToWhitelistRow,
  normalizeAccountNumber,
  normalizeDocumentId,
  outranks,
  parseCsvLine,
  parseStatus,
  pickStatus,
  whitelistRowToCsv,
  type WhitelistRow,
} from '../../src/modules/whitelist/whitelist.normalize.js';

describe('normalizeDocumentId', () => {
  it('cédula de 9 dígitos (entero sin el cero) → pad a 10, normalizada', () => {
    expect(normalizeDocumentId(912345678)).toEqual({
      documentId: '0912345678',
      documentNormalized: true,
    });
  });

  it('RUC de 12 dígitos → pad a 13, normalizado', () => {
    expect(normalizeDocumentId(990000000001)).toEqual({
      documentId: '0990000000001',
      documentNormalized: true,
    });
  });

  it('10 y 13 dígitos quedan tal cual', () => {
    expect(normalizeDocumentId(1712345678)).toEqual({
      documentId: '1712345678',
      documentNormalized: true,
    });
    expect(normalizeDocumentId('1790000000001')).toEqual({
      documentId: '1790000000001',
      documentNormalized: true,
    });
  });

  it('7-8 dígitos se dejan tal cual y NO normalizados', () => {
    expect(normalizeDocumentId(1234567)).toEqual({
      documentId: '1234567',
      documentNormalized: false,
    });
    expect(normalizeDocumentId(12345678)).toEqual({
      documentId: '12345678',
      documentNormalized: false,
    });
  });

  it('texto con separadores se compacta; pasaporte queda en mayúsculas sin normalizar', () => {
    expect(normalizeDocumentId(' 091234567-8 ')).toEqual({
      documentId: '0912345678',
      documentNormalized: true,
    });
    expect(normalizeDocumentId('ab123456')).toEqual({
      documentId: 'AB123456',
      documentNormalized: false,
    });
  });

  it('vacío / null → documentId vacío, no normalizado', () => {
    expect(normalizeDocumentId(null)).toEqual({ documentId: '', documentNormalized: false });
    expect(normalizeDocumentId('   ')).toEqual({ documentId: '', documentNormalized: false });
  });
});

describe('normalizeAccountNumber', () => {
  it('entero de Excel → string; texto numérico sin ceros a la izquierda', () => {
    expect(normalizeAccountNumber(90000001)).toBe('90000001');
    expect(normalizeAccountNumber(' 0090000001 ')).toBe('90000001');
    expect(normalizeAccountNumber('0')).toBe('0');
  });

  it('no numérica: recortada y en mayúsculas; vacía → null', () => {
    expect(normalizeAccountNumber(' wx-12 ')).toBe('WX-12');
    expect(normalizeAccountNumber('')).toBeNull();
    expect(normalizeAccountNumber(null)).toBeNull();
  });
});

describe('estados', () => {
  it('parseStatus acepta solo los 4 estados (sin importar mayúsculas/espacios)', () => {
    expect(parseStatus(' activo ')).toBe('ACTIVO');
    expect(parseStatus('CANCELADO')).toBeNull();
    expect(parseStatus(null)).toBeNull();
  });

  it('prioridad ACTIVO > SUSPENDIDO > ORDENADO > PENDIENTE', () => {
    expect(outranks('ACTIVO', 'SUSPENDIDO')).toBe(true);
    expect(outranks('SUSPENDIDO', 'ORDENADO')).toBe(true);
    expect(outranks('ORDENADO', 'PENDIENTE')).toBe(true);
    expect(outranks('PENDIENTE', 'ACTIVO')).toBe(false);
    expect(pickStatus(['PENDIENTE', 'SUSPENDIDO', 'ORDENADO'])).toBe('SUSPENDIDO');
    expect(pickStatus(['ORDENADO', 'ACTIVO'])).toBe('ACTIVO');
    expect(pickStatus([])).toBeNull();
  });
});

/** U+FFFD: el caracter de reemplazo que deja un encoding roto. */
const BROKEN = String.fromCharCode(0xfffd);

describe('cleanText', () => {
  it('quita U+FFFD y controles, colapsa espacios, NFC', () => {
    expect(cleanText(`Telefon${BROKEN}a  Locutorio	`)).toBe('Telefona Locutorio');
    expect(cleanText('Telefoni' + String.fromCharCode(0x301) + 'a')).toBe(
      'Telefon' + String.fromCharCode(0xed) + 'a',
    );
  });

  it('repara mojibake UTF-8 leído como Latin-1', () => {
    const mojibake = 'Telefon' + String.fromCharCode(0xc3, 0xad) + 'a Locutorio';
    expect(cleanText(mojibake)).toBe('Telefon' + String.fromCharCode(0xed) + 'a Locutorio');
  });

  it('números → string; vacío → null', () => {
    expect(cleanText(1234)).toBe('1234');
    expect(cleanText('  ')).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });
});

describe('CSV', () => {
  const row: WhitelistRow = {
    accountNumber: '90000001',
    documentId: '0900000001',
    documentNormalized: true,
    cpartyId: '777',
    status: 'SUSPENDIDO',
    city: 'CIUDAD, "SINTÉTICA"',
    node: null,
    businessType: 'Internet CM',
    accountType: 'Residencial',
    accessType: null,
    fullName: 'NOMBRE, "SINTÉTICO"',
  };

  it('ida y vuelta conserva comas, comillas y nulls', () => {
    expect(csvLineToWhitelistRow(whitelistRowToCsv(row))).toEqual(row);
  });

  it('parseCsvLine distingue vacío sin comillas (null) de "" (cadena vacía)', () => {
    expect(parseCsvLine('a,,""')).toEqual(['a', null, '']);
  });

  it('rechaza cuenta no normalizada, estado desconocido y columnas de más', () => {
    const base = whitelistRowToCsv(row);
    expect(() => csvLineToWhitelistRow(base.replace('"90000001"', '"090000001"'))).toThrow(
      /no está normalizado/,
    );
    expect(() => csvLineToWhitelistRow(base.replace('SUSPENDIDO', 'CANCELADO'))).toThrow(/status/);
    expect(() => csvLineToWhitelistRow(`${base},"extra"`)).toThrow(/columnas/);
  });

  it('formato v1 (sin fullName) sigue siendo legible: fullName null', () => {
    // v1 = la misma fila sin la última columna (fullName vacío deja una coma final).
    const v1 = whitelistRowToCsv({ ...row, fullName: null }).slice(0, -1);
    expect(csvLineToWhitelistRow(v1, 1)).toEqual({ ...row, fullName: null });
    // Una fila v1 leída como v2 (o al revés) falla por número de columnas.
    expect(() => csvLineToWhitelistRow(v1, 2)).toThrow(/columnas/);
    expect(() => csvLineToWhitelistRow(whitelistRowToCsv(row), 1)).toThrow(/columnas/);
  });
});
