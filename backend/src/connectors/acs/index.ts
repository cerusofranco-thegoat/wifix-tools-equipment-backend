// Conector hacia ACS (TR-069) — campos 19, 20, 21 (red local y WiFi).

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

export type WifiBand = '2.4GHz' | '5GHz';

export interface LanDevice {
  hostname: string;
  ipAddress: string;
  macAddress: string;
  leaseExpiresAt: string;
}

export interface WifiDevice {
  hostname: string;
  macAddress: string;
  band: WifiBand;
  signalDbm: number;
}

export interface WifiBandConfig {
  band: WifiBand;
  ssid: string;
}

export interface WifiConfig {
  accountNumber: string;
  bands: WifiBandConfig[];
}

export interface WifiBandUpdate {
  band: WifiBand;
  ssid: string;
  password?: string;
}

export interface WifiConfigUpdate {
  bands: WifiBandUpdate[];
}

export interface AcsConnector {
  getLanDevices(accountNumber: string): Promise<LanDevice[]>;
  getWifiDevices(accountNumber: string): Promise<WifiDevice[]>;
  getWifiConfig(accountNumber: string): Promise<WifiConfig>;
  updateWifiConfig(
    accountNumber: string,
    input: WifiConfigUpdate,
  ): Promise<WifiConfig>;
}

const HOSTNAMES = [
  'iPhone-Maria', 'Android-Juan', 'LaptopHP', 'MacBook-Pro', 'TV-Samsung',
  'Chromecast', 'PS5', 'Xbox-Series', 'Switch-Nintendo', 'Echo-Dot',
  'Roomba', 'TP-Link-Repetidor', 'Camara-Sala', 'Camara-Patio',
];

const MAC_PREFIXES = ['00:1A:2B', 'A4:B8:7E', '3C:5A:B4', 'F0:18:98', '54:E1:AD'];

function makeMac(rng: ReturnType<typeof seededRng>): string {
  const prefix = rng.pick(MAC_PREFIXES);
  const tail = Array.from({ length: 3 }, () =>
    rng.intBetween(0, 255).toString(16).padStart(2, '0').toUpperCase(),
  ).join(':');
  return `${prefix}:${tail}`;
}

function inferLastName(accountNumber: string): string {
  const last = ['Cevallos', 'Mendoza', 'Suárez', 'Yépez', 'Ramírez', 'Andrade'];
  const rng = seededRng(`acs:wifi-suffix:${accountNumber}`);
  return rng.pick(last);
}

function buildWifiBands(accountNumber: string): WifiBandConfig[] {
  const suffix = inferLastName(accountNumber);
  return [
    { band: '2.4GHz', ssid: `WIFIX_${suffix}` },
    { band: '5GHz', ssid: `WIFIX_${suffix}_5G` },
  ];
}

const wifiOverrides = new Map<string, WifiBandConfig[]>();

/**
 * Época de referencia fija para el mock ACS.
 * Usar Date.now() como base haría que leaseExpiresAt cambie entre llamadas
 * (aunque el offset seeded sea idéntico), rompiendo los tests de determinismo.
 * Con esta constante, mismo accountNumber → misma lista byte a byte.
 */
const ACS_MOCK_EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');

export const acsMock: AcsConnector = {
  async getLanDevices(accountNumber) {
    const rng = seededRng(`acs:lan:${accountNumber}`);
    const n = rng.intBetween(2, 6);
    const devices: LanDevice[] = [];
    for (let i = 0; i < n; i++) {
      const lease = new Date(ACS_MOCK_EPOCH_MS + rng.intBetween(30, 1440) * 60 * 1000);
      devices.push({
        hostname: `${rng.pick(HOSTNAMES)}-${i + 1}`,
        ipAddress: `192.168.1.${rng.intBetween(20, 220)}`,
        macAddress: makeMac(rng),
        leaseExpiresAt: lease.toISOString(),
      });
    }
    return devices;
  },

  async getWifiDevices(accountNumber) {
    const rng = seededRng(`acs:wifi:${accountNumber}`);
    const n = rng.intBetween(2, 8);
    const devices: WifiDevice[] = [];
    for (let i = 0; i < n; i++) {
      const band: WifiBand = rng.bool(0.6) ? '5GHz' : '2.4GHz';
      devices.push({
        hostname: `${rng.pick(HOSTNAMES)}-${i + 1}`,
        macAddress: makeMac(rng),
        band,
        signalDbm: band === '5GHz'
          ? rng.floatBetween(-70, -42, 1)
          : rng.floatBetween(-78, -50, 1),
      });
    }
    return devices;
  },

  async getWifiConfig(accountNumber) {
    const override = wifiOverrides.get(accountNumber);
    return {
      accountNumber,
      bands: override ?? buildWifiBands(accountNumber),
    };
  },

  async updateWifiConfig(accountNumber, input) {
    const current = wifiOverrides.get(accountNumber) ?? buildWifiBands(accountNumber);
    const merged = current.map((existing) => {
      const update = input.bands.find((b) => b.band === existing.band);
      return update ? { band: update.band, ssid: update.ssid } : existing;
    });
    // Si se incluyó una banda nueva, agregarla.
    for (const updated of input.bands) {
      if (!merged.find((m) => m.band === updated.band)) {
        merged.push({ band: updated.band, ssid: updated.ssid });
      }
    }
    wifiOverrides.set(accountNumber, merged);
    return { accountNumber, bands: merged };
  },
};

export const acsReal: AcsConnector = {
  async getLanDevices(_accountNumber) {
    notImplemented('acs.getLanDevices');
  },
  async getWifiDevices(_accountNumber) {
    notImplemented('acs.getWifiDevices');
  },
  async getWifiConfig(_accountNumber) {
    notImplemented('acs.getWifiConfig');
  },
  async updateWifiConfig(_accountNumber, _input) {
    notImplemented('acs.updateWifiConfig');
  },
};

export function getAcsConnector(): AcsConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return acsMock;
    case 'real':
      return acsReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
