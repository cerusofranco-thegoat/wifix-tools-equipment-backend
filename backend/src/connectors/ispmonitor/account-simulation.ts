// Simulación DETERMINÍSTICA de lo que la operadora sabe de una cuenta en su
// red de acceso: tecnología (GPON/HFC), equipo instalado y ubicación en la red
// (red de acceso + NAP/tap). Es la fuente ÚNICA que comparten:
//
//   - ISP Monitor por cuenta (`/accounts/:n/isp-monitor[...]`)
//   - `/accounts/:n/network-metrics` (mock)
//   - `/orders/context` (TYTAN simulado: technology, tipos de tarea, equipos, NAP)
//
// así la orden y el ISP Monitor nunca se contradicen. Función pura: misma
// cuenta → mismos datos. No llama a TEC ni a ninguna API de la operadora.
//
// TODO(tytan-real): la tecnología y el equipo reales vendrán del inventario de
// la operadora (TYTAN). TODO(tec-real): el mapeo cuenta → serial/MAC real se
// resolverá contra TEC cuando el acceso desde el servidor esté habilitado y la
// operadora autorice la consulta (hoy bloqueado desde Quasar).

import { seededRng, type SeededRng } from '../_shared.js';

export type AccountTechnology = 'GPON' | 'HFC';

/**
 * Forma canónica de la cuenta para sembrar la simulación: sin espacios, sin
 * ceros a la izquierda si es numérica y en mayúsculas. Así `0100926544` y
 * `100926544` son la misma cuenta (igual que la whitelist).
 */
export function canonicalAccount(raw: string): string {
  const value = raw.trim().replace(/\s+/g, '');
  if (/^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  return value.toUpperCase();
}

/**
 * Tecnología de acceso de la cuenta (≈70 % GPON / 30 % HFC), SIMULADA.
 * La usan ISP Monitor, network-metrics y la orden simulada.
 *
 * TODO(tytan-real): leer la tecnología real del inventario de la operadora.
 */
export function resolveAccountTechnology(accountNumber: string): AccountTechnology {
  return seededRng(`isp:technology:${canonicalAccount(accountNumber)}`).bool(0.7) ? 'GPON' : 'HFC';
}

/**
 * Ciudad de respaldo de la cuenta cuando la whitelist no la trae (o trae una
 * que la simulación no modela): 65 % Guayaquil / 35 % Quito. Compartida por la
 * orden simulada y el ISP Monitor por cuenta.
 */
export function simulatedCity(accountNumber: string): 'Guayaquil' | 'Quito' {
  return seededRng(`isp:city:${canonicalAccount(accountNumber)}`).bool(0.65) ? 'Guayaquil' : 'Quito';
}

const HEX = '0123456789ABCDEF';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function randomHex(rng: SeededRng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += HEX[rng.intBetween(0, 15)];
  return out;
}

export function randomLetters(rng: SeededRng, length: number, alphabet = LETTERS): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[rng.intBetween(0, alphabet.length - 1)];
  return out;
}

/** `A0092E5751EC` → `A0:09:2E:57:51:EC`. */
export function formatMac(mac12: string): string {
  return (mac12.match(/.{2}/g) ?? []).join(':');
}

/** Equipo del cliente tal como lo conoce la operadora. */
export interface SimulatedClientDevice {
  technology: AccountTechnology;
  /**
   * Identificador en ISP Monitor: serial GPON (`ZTEG` + 8 hex) o, en HFC, la
   * MAC del cablemódem (12 hex sin separadores).
   */
  ispId: string;
  /** Serial físico del equipo (en GPON coincide con `ispId`). */
  serial: string;
  /** MAC (12 hex, sin separadores). En HFC es el `ispId`. */
  mac: string;
  /** Modelo como lo muestra ISP Monitor (`F6600V9.0`, `CODA-4582U`). */
  model: string;
  /** Modelo como lo nombra la orden de TYTAN/FSM. */
  orderModel: string;
  vendor: 'zte' | 'hitron';
  version: string;
  software: string;
}

/**
 * Equipo instalado en la cuenta: GPON → ONT ZTE F6600 (serial ZTEG…);
 * HFC → cablemódem Hitron CODA-4582U (identificado por MAC).
 */
export function simulatedClientDevice(accountNumber: string): SimulatedClientDevice {
  const account = canonicalAccount(accountNumber);
  const technology = resolveAccountTechnology(account);
  const rng = seededRng(`isp:client-device:${account}`);
  if (technology === 'GPON') {
    const serial = `ZTEG${randomHex(rng, 8)}`;
    return {
      technology,
      ispId: serial,
      serial,
      mac: `A0092E${randomHex(rng, 6)}`,
      model: 'F6600V9.0',
      orderModel: 'ONT ZTE ZXHN F6600 WIFI 6',
      vendor: 'zte',
      version: 'V9.0',
      software: rng.pick(['V9.0.10P2N8', 'V9.0.10P2N6', 'V9.0.11P1N2']),
    };
  }
  const mac = `BC4DFB${randomHex(rng, 6)}`;
  let digits = String(rng.intBetween(1, 9));
  for (let i = 1; i < 9; i++) digits += String(rng.intBetween(0, 9));
  return {
    technology,
    ispId: mac,
    serial: `HTRN${digits}`,
    mac,
    model: 'CODA-4582U',
    orderModel: 'CABLEMODEM HITRON CODA-4582U',
    vendor: 'hitron',
    version: '2A',
    software: rng.pick(['7.2.4.3.1b3', '7.2.4.5.2b1']),
  };
}

/** Ubicación de la cuenta en la red de acceso (no depende de la ciudad). */
export interface SimulatedAccessLayout {
  technology: AccountTechnology;
  /** Prefijo de zona (`HG4`). */
  zonePrefix: string;
  /** Red de acceso: puerto OLT (GPON) o tarjeta CMTS (HFC), p. ej. `HG4BF`. */
  accessNetwork: string;
  /** NAP (GPON, `HG4NB2`) o tap/derivador (HFC, `HG4TC5`) del cliente. */
  clientNap: string;
}

/**
 * Red de acceso y NAP/tap del cliente. La orden simulada usa `clientNap` como
 * `napCode` y `accessNetwork` como `zoneCode`, igual que ISP Monitor.
 */
export function simulatedAccessLayout(accountNumber: string): SimulatedAccessLayout {
  const account = canonicalAccount(accountNumber);
  const technology = resolveAccountTechnology(account);
  const rng = seededRng(`isp:layout:${account}`);
  const zonePrefix = `${randomLetters(rng, 2)}${rng.intBetween(1, 9)}`;
  const accessNetwork = `${zonePrefix}${randomLetters(rng, 2)}`;
  // NAP del cliente con 1 dígito (6 caracteres, formato de las notas de cierre).
  const kind = technology === 'GPON' ? 'N' : 'T';
  const clientNap = `${zonePrefix}${kind}${randomLetters(rng, 1, 'ABCDEF')}${rng.intBetween(1, 9)}`;
  return { technology, zonePrefix, accessNetwork, clientNap };
}
