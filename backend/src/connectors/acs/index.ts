// Conector hacia ACS (TR-069) — campos 19, 20, 21 (red local y WiFi).
// Fase C: añade reboot, setChannel, factoryReset, reprovision, runDiagnostic.

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

// ---------------------------------------------------------------------------
// Tipos de resultado para acciones de Fase C
// ---------------------------------------------------------------------------

export interface RebootResult {
  success: boolean;
  scheduledAt: string;
  estimatedDowntimeSeconds: number;
}

export interface SetChannelParams {
  band: WifiBand;
  channel: number;
}

export interface SetChannelResult {
  success: boolean;
  band: WifiBand;
  channel: number;
  appliedAt: string;
}

export interface FactoryResetResult {
  success: boolean;
  scheduledAt: string;
  warningMessage: string;
}

export interface ReprovisionResult {
  success: boolean;
  scheduledAt: string;
  message: string;
}

/**
 * Resultado de diagnóstico en formato TR-143 / herramientas de Wifix.
 * Reutiliza la estructura de PingTestDto y TracerouteDto del módulo herramientas:
 *   - ping: packetsSent, packetsReceived, packetLossPercent, minLatencyMs, avgLatencyMs, maxLatencyMs
 *   - traceroute: hops con hopNumber, host?, latencyMs?
 * El campo `kind` discrimina qué tipo de diagnóstico se corrió.
 */
export interface DiagnosticHop {
  hopNumber: number;
  host?: string;
  latencyMs?: number;
}

export interface DiagnosticResult {
  kind: 'ping' | 'traceroute';
  target: string;
  measuredAt: string;
  // Campos ping (TR-143 IPPing)
  packetsSent?: number;
  packetsReceived?: number;
  packetLossPercent?: number;
  minLatencyMs?: number;
  avgLatencyMs?: number;
  maxLatencyMs?: number;
  // Campos traceroute (TR-143 TraceRoute)
  hops?: DiagnosticHop[];
}

export interface RunDiagnosticParams {
  target: string;
  kind: 'ping' | 'traceroute';
}

// ---------------------------------------------------------------------------
// Interfaz del conector ACS
// ---------------------------------------------------------------------------

export interface AcsConnector {
  // Lectura de dispositivos y configuración (Fases anteriores)
  getLanDevices(accountNumber: string): Promise<LanDevice[]>;
  getWifiDevices(accountNumber: string): Promise<WifiDevice[]>;
  getWifiConfig(accountNumber: string): Promise<WifiConfig>;
  updateWifiConfig(
    accountNumber: string,
    input: WifiConfigUpdate,
  ): Promise<WifiConfig>;

  // Acciones de equipo — Fase C
  reboot(accountNumber: string): Promise<RebootResult>;
  setChannel(accountNumber: string, params: SetChannelParams): Promise<SetChannelResult>;
  factoryReset(accountNumber: string): Promise<FactoryResetResult>;
  reprovision(accountNumber: string): Promise<ReprovisionResult>;
  /**
   * Ejecuta ping o traceroute según `params.kind` ('ping' | 'traceroute')
   * y devuelve el resultado en formato TR-143, compatible con PingTestDto / TracerouteDto
   * del módulo /herramientas/v1. No reimplementa el diagnóstico: reutiliza el formato
   * de tipos definido en ping.mappers y traceroute.mappers.
   */
  runDiagnostic(accountNumber: string, params: RunDiagnosticParams): Promise<DiagnosticResult>;
}

// ---------------------------------------------------------------------------
// Helpers internos del mock
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock determinista
// ---------------------------------------------------------------------------

export const acsMock: AcsConnector = {
  async getLanDevices(accountNumber) {
    const rng = seededRng(`acs:lan:${accountNumber}`);
    const n = rng.intBetween(2, 6);
    const devices: LanDevice[] = [];
    for (let i = 0; i < n; i++) {
      const lease = new Date(Date.now() + rng.intBetween(30, 1440) * 60 * 1000);
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

  // -------------------------------------------------------------------------
  // Acciones de Fase C — mock determinista
  // Semilla: "acs:<accion>:<accountNumber>" para que el mismo input
  // produzca siempre el mismo resultado (determinismo).
  // -------------------------------------------------------------------------

  async reboot(accountNumber) {
    const rng = seededRng(`acs:reboot:${accountNumber}`);
    const downtime = rng.intBetween(30, 90);
    return {
      success: true,
      scheduledAt: new Date().toISOString(),
      estimatedDowntimeSeconds: downtime,
    };
  },

  async setChannel(_accountNumber, params) {
    // Resultado determinista: mismo band+channel → mismo output
    return {
      success: true,
      band: params.band,
      channel: params.channel,
      appliedAt: new Date().toISOString(),
    };
  },

  async factoryReset(accountNumber) {
    const rng = seededRng(`acs:factory-reset:${accountNumber}`);
    const messages = [
      'El equipo volverá a su configuración de fábrica.',
      'Se perderán todos los ajustes personalizados.',
      'El dispositivo reiniciará con parámetros de fábrica.',
    ];
    return {
      success: true,
      scheduledAt: new Date().toISOString(),
      warningMessage: rng.pick(messages),
    };
  },

  async reprovision(accountNumber) {
    const rng = seededRng(`acs:reprovision:${accountNumber}`);
    const messages = [
      'Reaprovisionamiento iniciado exitosamente.',
      'El equipo recibirá su configuración desde el ACS.',
      'Proceso de aprovisionamiento en cola.',
    ];
    return {
      success: true,
      scheduledAt: new Date().toISOString(),
      message: rng.pick(messages),
    };
  },

  async runDiagnostic(accountNumber, params) {
    /**
     * Resultado en formato TR-143, compatible con los tipos de
     * ping.mappers (PingTestDto) y traceroute.mappers (TracerouteDto)
     * del módulo /herramientas/v1. No reimplementa el diagnóstico:
     * reutiliza el mismo esquema de campos.
     *
     * El campo `kind` determina el tipo de diagnóstico: 'ping' o 'traceroute'.
     * Semilla: "acs:<kind>:<accountNumber>:<target>" para determinismo.
     */
    const { target, kind } = params;
    const measuredAt = new Date().toISOString();

    if (kind === 'traceroute') {
      const rng = seededRng(`acs:traceroute:${accountNumber}:${target}`);
      const hopCount = rng.intBetween(4, 10);
      const hops: DiagnosticHop[] = [];
      const hosts = [
        '192.168.1.1',
        '10.0.0.1',
        '172.16.0.1',
        '8.8.4.4',
        '142.250.0.1',
        '64.233.160.1',
        '216.58.0.1',
        '8.8.8.8',
        '1.1.1.1',
        '208.67.222.222',
      ];
      for (let i = 1; i <= hopCount; i++) {
        hops.push({
          hopNumber: i,
          host: rng.bool(0.85) ? rng.pick(hosts) : undefined,
          latencyMs: rng.bool(0.9) ? rng.floatBetween(1, 120, 1) : undefined,
        });
      }
      return {
        kind: 'traceroute',
        target,
        measuredAt,
        hops,
      };
    }

    // Ping — formato TR-143 IPPing
    const rng = seededRng(`acs:ping:${accountNumber}:${target}`);
    const packetsSent = 10;
    const lossCount = rng.intBetween(0, 2);
    const packetsReceived = packetsSent - lossCount;
    const minLatencyMs = rng.floatBetween(1, 30, 1);
    const avgLatencyMs = rng.floatBetween(minLatencyMs, minLatencyMs + 20, 1);
    const maxLatencyMs = rng.floatBetween(avgLatencyMs, avgLatencyMs + 30, 1);

    return {
      kind: 'ping',
      target,
      measuredAt,
      packetsSent,
      packetsReceived,
      packetLossPercent: parseFloat(((lossCount / packetsSent) * 100).toFixed(1)),
      minLatencyMs,
      avgLatencyMs,
      maxLatencyMs,
    };
  },
};

// ---------------------------------------------------------------------------
// Esqueleto real (stub — cuando se entreguen credenciales TR-069 se implementa)
// ---------------------------------------------------------------------------

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
  async reboot(_accountNumber) {
    notImplemented('acs.reboot');
  },
  async setChannel(_accountNumber, _params) {
    notImplemented('acs.setChannel');
  },
  async factoryReset(_accountNumber) {
    notImplemented('acs.factoryReset');
  },
  async reprovision(_accountNumber) {
    notImplemented('acs.reprovision');
  },
  async runDiagnostic(_accountNumber, _params) {
    notImplemented('acs.runDiagnostic');
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
