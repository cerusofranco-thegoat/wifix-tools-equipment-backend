// ISP Monitor por número de cuenta — generador SIMULADO y DETERMINÍSTICO.
//
// Reproduce lo que el técnico ve en el ISP Monitor de la operadora: búsqueda
// "# Cuenta" → fila del equipo → "ONU Info" (GPON) o ficha del cablemódem
// (HFC) → "Listado de equipos" de la red de acceso agrupado por NAP, con el
// estado working/lost de cada equipo para decidir si la falla es interna o
// externa a la NAP.
//
// Función pura: misma cuenta (y mismo `now`) → mismos datos. Tecnología, equipo
// y NAP del cliente salen de `account-simulation.ts`, la misma fuente que usa
// la orden simulada (`/orders/context`), así ambas pantallas coinciden.
//
// Reglas de la operadora: no se exponen ifIndex/index internos del monitoreo
// y se habla de "red de acceso", nunca de "nodo".
//
// TODO(tec-real): con acceso a TEC, la ficha saldría de
// `/api/isp/terminals/{serial}` con el serial real de la cuenta (mapeo
// cuenta → serial pendiente), y el listado, de los terminales del mismo puerto
// OLT / tarjeta CMTS. Hoy NO se consulta TEC desde estas rutas.

import { seededRng, type SeededRng } from '../../connectors/_shared.js';
import {
  canonicalAccount,
  formatMac,
  randomHex,
  simulatedAccessLayout,
  simulatedCity,
  simulatedClientDevice,
  type AccountTechnology,
} from '../../connectors/ispmonitor/account-simulation.js';

// ---------------------------------------------------------------------------
// Tipos del contrato
// ---------------------------------------------------------------------------

export type DeviceState = 'working' | 'lost';
export type IspAccountStatus = 'A' | 'S' | 'T';
export type DiagnosisScope = 'NONE' | 'INTERNAL' | 'EXTERNAL_NAP' | 'EXTERNAL_NETWORK';
export type OfflineCause = 'ONU LOS' | 'DYING GASP';

export interface IspPlan {
  /** Profile de la OLT/CMTS: `RES-<kbps>/<kbps>-I`. */
  profile: string;
  downloadKbps: number;
  uploadKbps: number;
  downloadMbps: number;
  uploadMbps: number;
  name: string;
}

export interface IspSearchRow {
  serial: string;
  city: string;
  accessNetwork: string;
  profile: string;
  accountNumber: string;
  accountStatus: IspAccountStatus;
  clientName: string;
}

export interface IspServicePort {
  id: number;
  mode: 'tag';
  vlanIn: number;
  vlanOut: number;
  service: string;
  trafficProfile: string;
  macLearned: number;
  state: 'up' | 'down';
}

export interface IspCpe {
  ip: string;
  mac: string;
  vendor: string;
}

/**
 * Capa óptica (GPON). Con el equipo `lost` la OLT no tiene lectura: los valores
 * van `null` y los semáforos en rojo (`false`).
 */
export interface IspOptics {
  distanceMeters: number | null;
  rxOltDbm: number | null;
  txDbm: number | null;
  rxDbm: number | null;
  voltage: number | null;
  temperatureC: number | null;
  rxOltOk: boolean;
  txOk: boolean;
  rxOk: boolean;
}

export interface IspDevice {
  serial: string;
  model: string;
  version: string;
  software: string;
  state: DeviceState;
  adminState: 'up' | 'down';
  /** GPON: puerto OLT (`gpon_olt-1/3/10`). HFC: interfaz del CMTS. */
  port: string;
  accessNetwork: string;
  /** GPON: headend/OLT. HFC: CMTS. */
  headend: string;
  /** Solo GPON (`gpon-onu_1/3/10:31`); HFC → null. */
  onuId: string | null;
  lastOnline: string;
  lastOffline: string | null;
  /** Causa de la última caída (GPON). HFC → null. */
  offlineCause: OfflineCause | null;
  speedMode: string;
  /** GPON: NAP. HFC: tap/derivador. */
  nap: string;
  client: { accountNumber: string; name: string; address: string };
  /** Solo GPON; HFC → []. */
  servicePorts: IspServicePort[];
  wanIp: 'DHCP';
  cpes: IspCpe[];
  /** Solo GPON; HFC → null. */
  optics: IspOptics | null;
}

export interface DocsisChannelReading {
  channel: number;
  frequencyMHz: number;
  powerDbmv: number;
  snrDb: number;
}

export interface IspDocsis {
  downstream: DocsisChannelReading[];
  upstream: DocsisChannelReading[];
  codewords: { corrected: number; uncorrected: number };
  ok: boolean;
}

export interface IspMonitorAccount {
  simulated: true;
  source: 'ISP_MONITOR';
  technology: AccountTechnology;
  searchRow: IspSearchRow;
  plan: IspPlan;
  device: IspDevice | null;
  /** Solo HFC. En GPON SIEMPRE null. */
  docsis: IspDocsis | null;
}

export interface AccessDevice {
  serial: string;
  accountNumber: string;
  services: { internet: boolean; phone: boolean; tv: boolean };
  clientName: string;
  accountStatus: IspAccountStatus;
  state: DeviceState;
  isClient: boolean;
}

export interface AccessNap {
  nap: string;
  summary: { total: number; working: number; lost: number; state: 'OK' | 'PARTIAL' | 'DOWN' };
  devices: AccessDevice[];
}

export interface AccessDiagnosis {
  scope: DiagnosisScope;
  message: string;
}

export interface IspAccessNetwork {
  simulated: true;
  accessNetwork: string;
  technology: AccountTechnology;
  clientNap: string;
  naps: AccessNap[];
  totals: { devices: number; working: number; lost: number };
  diagnosis: AccessDiagnosis;
}

/** Lo que el servicio aporta de otras fuentes (plan de client-profile, whitelist). */
export interface IspClientInput {
  accountNumber: string;
  /** Nombre del cliente (se publica en MAYÚSCULAS). */
  clientName: string;
  accountStatus: IspAccountStatus;
  /** Ciudad conocida (whitelist); si no, se simula Guayaquil/Quito. */
  city: string | null;
  plan: IspPlan;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Plan en bits a partir del plan de client-profile (Comarch mock, simétrico).
 * 300 Mbps → `RES-300000/300000-I`.
 */
export function planFromContract(input: {
  planName: string;
  contractedDownloadMbps: number;
  contractedUploadMbps: number;
}): IspPlan {
  const downloadKbps = Math.round(input.contractedDownloadMbps * 1000);
  const uploadKbps = Math.round(input.contractedUploadMbps * 1000);
  return {
    profile: `RES-${downloadKbps}/${uploadKbps}-I`,
    downloadKbps,
    uploadKbps,
    downloadMbps: input.contractedDownloadMbps,
    uploadMbps: input.contractedUploadMbps,
    name: input.planName,
  };
}

// ---------------------------------------------------------------------------
// Catálogos (estilo ISP Monitor de la operadora)
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'GALO', 'ALFREDO', 'EDISON', 'LENIN', 'MARIA', 'JOSE', 'ROSA', 'LUIS', 'CARMEN', 'JORGE',
  'PATRICIA', 'WILSON', 'NANCY', 'FREDDY', 'JESSICA', 'KLEBER', 'MAYRA', 'BYRON', 'GLADYS',
  'HECTOR', 'NARCISA', 'WASHINGTON', 'DIANA', 'SEGUNDO',
];
const LAST_NAMES = [
  'ESPINOZA', 'CEDEÑO', 'RIZZO', 'PLUAS', 'MOREIRA', 'VERA', 'ZAMBRANO', 'QUIMI', 'BAJAÑA',
  'PINCAY', 'TOMALA', 'VILLAMAR', 'CHILAN', 'GUAMAN', 'TOAPANTA', 'PILLAJO', 'CHICAIZA',
  'SUAREZ', 'MACIAS', 'ALAVA', 'MUÑOZ', 'YAGUAL',
];

const SECTORS: Record<'Guayaquil' | 'Quito', readonly string[]> = {
  Guayaquil: ['URDESA CENTRAL', 'KENNEDY NORTE', 'LOS ESTEROS', 'BASTION POPULAR', 'SAUCES 8', 'ALBORADA 10'],
  Quito: ['LA CAROLINA', 'SANTA RITA', 'LA FLORIDA', 'LA KENNEDY', 'CARCELEN', 'CONOCOTO'],
};

const CITY_CODES: Record<string, string> = {
  Guayaquil: 'GYE',
  Quito: 'UIO',
  Cuenca: 'CUE',
  Ambato: 'AMB',
  Loja: 'LOJ',
  Manta: 'MEC',
  Machala: 'MCH',
  Portoviejo: 'PVO',
  Duran: 'DUR',
  Riobamba: 'RIO',
};

const NEIGHBOR_PREFIXES = ['ZTEG', 'STGU', 'XPON'] as const;

// ---------------------------------------------------------------------------
// Mundo simulado de la cuenta
// ---------------------------------------------------------------------------

interface WorldDevice extends AccessDevice {
  /** Solo para el cliente: causa de la caída en curso. */
  cause?: OfflineCause;
}

interface AccessWorld {
  account: string;
  technology: AccountTechnology;
  scenario: DiagnosisScope;
  city: string;
  accessNetwork: string;
  clientNap: string;
  headend: string;
  port: string;
  onuId: string | null;
  naps: Array<{ nap: string; devices: WorldDevice[] }>;
  clientServices: AccessDevice['services'];
}

/** Escenario de falla de la cuenta: ~90 % sin falla, ~10 % repartido en 3 casos. */
export function simulatedScenario(accountNumber: string): DiagnosisScope {
  const r = seededRng(`isp:scenario:${canonicalAccount(accountNumber)}`).next();
  if (r < 0.9) return 'NONE';
  if (r < 0.9333) return 'INTERNAL';
  if (r < 0.9667) return 'EXTERNAL_NAP';
  return 'EXTERNAL_NETWORK';
}

function titleCity(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim().toUpperCase();
  if (text.includes('GUAYAQUIL')) return 'Guayaquil';
  if (text.includes('QUITO')) return 'Quito';
  const known = Object.keys(CITY_CODES).find((c) => c.toUpperCase() === text);
  return known ?? null;
}

function personName(rng: SeededRng): string {
  const first = rng.sample(FIRST_NAMES, 2).join(' ');
  return `${first} ${rng.pick(LAST_NAMES)} ${rng.pick(LAST_NAMES)}`;
}

function neighborStatus(rng: SeededRng): IspAccountStatus {
  const r = rng.next();
  return r < 0.85 ? 'A' : r < 0.95 ? 'S' : 'T';
}

function services(rng: SeededRng): AccessDevice['services'] {
  return { internet: true, phone: rng.bool(0.35), tv: rng.bool(0.45) };
}

function setLost(devices: WorldDevice[], count: number, rng: SeededRng): void {
  const pool = devices.filter((d) => d.state === 'working');
  for (const device of rng.sample(pool, count)) device.state = 'lost';
}

function buildWorld(input: IspClientInput): AccessWorld {
  const account = canonicalAccount(input.accountNumber);
  const layout = simulatedAccessLayout(account);
  const client = simulatedClientDevice(account);
  const scenario = simulatedScenario(account);
  const rng = seededRng(`isp:world:${account}`);
  const technology = layout.technology;

  // Ciudad de la whitelist si la trae; si no, la misma de respaldo que la orden.
  const city = titleCity(input.city) ?? simulatedCity(account);
  const cityCode = CITY_CODES[city] ?? city.slice(0, 3).toUpperCase();
  const slot = rng.intBetween(1, 16);
  const pon = rng.intBetween(1, 16);
  const headend =
    technology === 'GPON'
      ? `${cityCode} HEADEND ZTE ${rng.intBetween(1, 4)}`
      : `${cityCode} CMTS CASA ${rng.intBetween(1, 3)}`;
  const port = technology === 'GPON' ? `gpon_olt-1/${slot}/${pon}` : `Cable${slot}/0/${pon}`;
  const onuId = technology === 'GPON' ? `gpon-onu_1/${slot}/${pon}:${rng.intBetween(1, 64)}` : null;

  // NAPs/taps de la red de acceso: la del cliente primero.
  const napCount = rng.intBetween(4, 7);
  const kind = technology === 'GPON' ? 'N' : 'T';
  const napCodes = new Set<string>([layout.clientNap]);
  while (napCodes.size < napCount) {
    napCodes.add(`${layout.zonePrefix}${kind}${'ABCDEF'[rng.intBetween(0, 5)]}${rng.intBetween(1, 16)}`);
  }

  const usedAccounts = new Set<string>([account]);
  const newAccount = (): string => {
    for (;;) {
      const candidate = String(rng.intBetween(10_000_000, 199_999_999));
      if (!usedAccounts.has(candidate)) {
        usedAccounts.add(candidate);
        return candidate;
      }
    }
  };
  const neighborSerial = (): string =>
    technology === 'GPON' ? `${rng.pick(NEIGHBOR_PREFIXES)}${randomHex(rng, 8)}` : randomHex(rng, 12);

  const clientServices = services(rng);
  const naps = [...napCodes].map((nap, napIndex) => {
    const isClientNap = napIndex === 0;
    const size = isClientNap ? rng.intBetween(3, 8) : rng.intBetween(2, 8);
    const clientPos = isClientNap ? rng.intBetween(0, size - 1) : -1;
    const devices: WorldDevice[] = [];
    for (let i = 0; i < size; i++) {
      if (i === clientPos) {
        devices.push({
          serial: client.ispId,
          accountNumber: account,
          services: clientServices,
          clientName: input.clientName,
          accountStatus: input.accountStatus,
          state: 'working',
          isClient: true,
        });
        continue;
      }
      devices.push({
        serial: neighborSerial(),
        accountNumber: newAccount(),
        services: services(rng),
        clientName: personName(rng),
        accountStatus: neighborStatus(rng),
        state: 'working',
        isClient: false,
      });
    }
    return { nap, devices };
  });

  const clientNapDevices = (naps[0] as { devices: WorldDevice[] }).devices;
  const clientDevice = clientNapDevices.find((d) => d.isClient) as WorldDevice;

  switch (scenario) {
    case 'NONE':
      // Caídas aisladas en otras NAPs (máx. 1 por NAP de 4+ equipos): no
      // forman patrón (< 50 % de su NAP y < 30 % de la red).
      for (const nap of naps.slice(1)) {
        if (nap.devices.length >= 4 && rng.bool(0.25)) setLost(nap.devices, 1, rng);
      }
      break;
    case 'INTERNAL':
      clientDevice.state = 'lost';
      clientDevice.cause = rng.bool(0.5) ? 'DYING GASP' : 'ONU LOS';
      break;
    case 'EXTERNAL_NAP': {
      clientDevice.state = 'lost';
      clientDevice.cause = 'ONU LOS';
      const total = clientNapDevices.length;
      const lost = rng.intBetween(Math.ceil(total / 2), total);
      setLost(clientNapDevices, lost - 1, rng);
      break;
    }
    case 'EXTERNAL_NETWORK': {
      clientDevice.cause = 'ONU LOS';
      for (const d of clientNapDevices) d.state = 'lost';
      const allDevices = naps.reduce((n, x) => n + x.devices.length, 0);
      const others = rng.sample(naps.slice(1), naps.length - 1);
      let lost = clientNapDevices.length;
      let napsDown = 1;
      for (const nap of others) {
        if (napsDown >= 2 && lost / allDevices >= 0.3) break;
        for (const d of nap.devices) d.state = 'lost';
        lost += nap.devices.length;
        napsDown += 1;
      }
      break;
    }
  }

  return {
    account,
    technology,
    scenario,
    city,
    accessNetwork: layout.accessNetwork,
    clientNap: layout.clientNap,
    headend,
    port,
    onuId,
    naps,
    clientServices,
  };
}

// ---------------------------------------------------------------------------
// Diagnóstico (regla pura sobre los datos, no sobre el escenario)
// ---------------------------------------------------------------------------

function napSummary(devices: AccessDevice[]): AccessNap['summary'] {
  const total = devices.length;
  const lost = devices.filter((d) => d.state === 'lost').length;
  const working = total - lost;
  const state = lost === 0 ? 'OK' : lost === total ? 'DOWN' : 'PARTIAL';
  return { total, working, lost, state };
}

/**
 * Reglas (en este orden):
 *  1. ≥ 30 % de la red de acceso lost repartido en ≥ 2 NAPs → EXTERNAL_NETWORK.
 *  2. ≥ 50 % de la NAP del cliente lost → EXTERNAL_NAP.
 *  3. El equipo del cliente lost (y su NAP con el resto working) → INTERNAL.
 *  4. Si no → NONE.
 * La NAP del cliente es la primera de `naps`.
 */
export function diagnoseAccessNetwork(
  naps: AccessNap[],
  ctx: { accessNetwork: string; technology: AccountTechnology },
): AccessDiagnosis {
  const total = naps.reduce((n, x) => n + x.summary.total, 0);
  const lost = naps.reduce((n, x) => n + x.summary.lost, 0);
  const napsWithLost = naps.filter((x) => x.summary.lost > 0).length;
  const clientNap = naps[0];
  const client = clientNap?.devices.find((d) => d.isClient);
  const napWord = ctx.technology === 'GPON' ? 'NAP' : 'tap';

  if (total > 0 && lost / total >= 0.3 && napsWithLost >= 2) {
    const upstream = ctx.technology === 'GPON' ? 'OLT/puerto PON/troncal de fibra' : 'CMTS/troncal coaxial';
    return {
      scope: 'EXTERNAL_NETWORK',
      message:
        `${lost} de ${total} equipos de la red de acceso ${ctx.accessNetwork} están lost en ` +
        `${napsWithLost} ${napWord}s: la falla es externa, de la red de acceso (${upstream}). ` +
        `Escalar a NOC / planta externa.`,
    };
  }
  if (clientNap && clientNap.summary.total > 0 && clientNap.summary.lost / clientNap.summary.total >= 0.5) {
    return {
      scope: 'EXTERNAL_NAP',
      message:
        `${clientNap.summary.lost} de ${clientNap.summary.total} equipos de la ${napWord} ` +
        `${clientNap.nap} están lost: la falla es externa a la ${napWord} ` +
        `(${napWord}/splitter o su alimentación), no del domicilio.`,
    };
  }
  if (client?.state === 'lost') {
    return {
      scope: 'INTERNAL',
      message:
        'Solo el equipo del cliente está lost: la falla es interna (domicilio/drop/equipo).',
    };
  }
  return {
    scope: 'NONE',
    message:
      lost === 0
        ? 'El equipo del cliente está working y la red de acceso no muestra equipos lost.'
        : `El equipo del cliente está working. Hay ${lost} equipo(s) lost aislados en otras ` +
          `${napWord}s, sin patrón de falla externa.`,
  };
}

// ---------------------------------------------------------------------------
// Proyecciones del contrato
// ---------------------------------------------------------------------------

/** Instante redondeado al segundo, `offsetMs` antes de `now`. */
function ago(now: Date, offsetMs: number): string {
  return new Date(Math.floor((now.getTime() - offsetMs) / 1000) * 1000).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function publicIp(rng: SeededRng): string {
  const base = rng.pick(['190.155', '186.4', '181.199', '200.63']);
  return `${base}.${rng.intBetween(1, 254)}.${rng.intBetween(2, 254)}`;
}

function inRange(v: number | null, min: number, max: number): boolean {
  return v !== null && v >= min && v <= max;
}

function buildOptics(rng: SeededRng, state: DeviceState): IspOptics {
  if (state === 'lost') {
    return {
      distanceMeters: null,
      rxOltDbm: null,
      txDbm: null,
      rxDbm: null,
      voltage: null,
      temperatureC: null,
      rxOltOk: false,
      txOk: false,
      rxOk: false,
    };
  }
  // ~8 % con potencia Rx degradada (semáforo rojo con el equipo arriba).
  const degraded = rng.bool(0.08);
  const rxDbm = degraded ? rng.floatBetween(-29.5, -27.2, 1) : rng.floatBetween(-24.5, -14, 1);
  const rxOltDbm = degraded ? rng.floatBetween(-28.6, -26, 1) : rng.floatBetween(-26.5, -15, 1);
  const txDbm = rng.floatBetween(1.8, 2.8, 1);
  return {
    distanceMeters: rng.intBetween(300, 9000),
    rxOltDbm,
    txDbm,
    rxDbm,
    voltage: rng.floatBetween(3.22, 3.32, 2),
    temperatureC: rng.floatBetween(35, 55, 2),
    // Umbrales Clase B+: Rx ONT -8…-27, Rx OLT -8…-28, Tx 0.5…5 dBm.
    rxOltOk: inRange(rxOltDbm, -28, -8),
    txOk: inRange(txDbm, 0.5, 5),
    rxOk: inRange(rxDbm, -27, -8),
  };
}

const DOCSIS_DOWN_FREQ_START = 573;
const DOCSIS_UP_FREQS = [16.4, 22.8, 29.2, 35.6];

function buildDocsis(rng: SeededRng, state: DeviceState): IspDocsis {
  if (state === 'lost') {
    return { downstream: [], upstream: [], codewords: { corrected: 0, uncorrected: 0 }, ok: false };
  }
  const degraded = rng.bool(0.1);
  const downstream: DocsisChannelReading[] = Array.from({ length: 8 }, (_, i) => ({
    channel: i + 1,
    frequencyMHz: DOCSIS_DOWN_FREQ_START + i * 6,
    powerDbmv: rng.floatBetween(-5, 6, 1),
    snrDb: degraded && i >= 6 ? rng.floatBetween(28, 32.5, 1) : rng.floatBetween(35, 41, 1),
  }));
  const upstream: DocsisChannelReading[] = DOCSIS_UP_FREQS.map((frequencyMHz, i) => ({
    channel: i + 1,
    frequencyMHz,
    powerDbmv: rng.floatBetween(38, 47, 1),
    snrDb: rng.floatBetween(30, 37, 1),
  }));
  const codewords = {
    corrected: rng.intBetween(0, 5000),
    uncorrected: degraded ? rng.intBetween(200, 2000) : rng.intBetween(0, 40),
  };
  // Umbrales DOCSIS (mismos de /terminals/:id/diagnostics).
  const ok =
    downstream.every((c) => inRange(c.powerDbmv, -7, 7) && c.snrDb >= 33) &&
    upstream.every((c) => inRange(c.powerDbmv, 35, 51) && c.snrDb >= 27) &&
    codewords.uncorrected < 100;
  return { downstream, upstream, codewords, ok };
}

function clientAddress(rng: SeededRng, city: string): string {
  if (city === 'Quito') {
    return `${rng.pick(SECTORS.Quito)}, CALLE N${rng.intBetween(10, 80)} Y OE${rng.intBetween(1, 12)}, CASA ${rng.intBetween(1, 120)}, QUITO`;
  }
  const sector = city === 'Guayaquil' ? rng.pick(SECTORS.Guayaquil) : 'CENTRO';
  return `MZ. ${rng.intBetween(1, 450)} SOLAR ${rng.intBetween(1, 30)}, ${sector}, ${city.toUpperCase()}`;
}

/** `GET /accounts/:n/isp-monitor`. */
export function buildIspMonitorAccount(input: IspClientInput, now: Date = new Date()): IspMonitorAccount {
  const world = buildWorld(input);
  const client = simulatedClientDevice(world.account);
  const clientDevice = (world.naps[0]?.devices.find((d) => d.isClient)) as WorldDevice;
  const state = clientDevice.state;
  const rng = seededRng(`isp:device:${world.account}`);
  const plan = input.plan;
  const adminState: 'up' | 'down' = input.accountStatus === 'A' ? 'up' : 'down';
  const isGpon = world.technology === 'GPON';

  // Tiempos: working → última vuelta hace horas/días; lost → caída en curso.
  let lastOnline: string;
  let lastOffline: string | null;
  let offlineCause: OfflineCause | null = null;
  if (state === 'lost') {
    const downFor = rng.intBetween(5, 240) * MINUTE;
    lastOffline = ago(now, downFor);
    lastOnline = ago(now, downFor + rng.intBetween(1, 20) * DAY + rng.intBetween(0, 23) * HOUR);
    offlineCause = isGpon ? (clientDevice.cause ?? 'ONU LOS') : null;
  } else {
    const upFor = rng.intBetween(1, 30 * 24) * HOUR + rng.intBetween(0, 59) * MINUTE;
    lastOnline = ago(now, upFor);
    lastOffline = ago(now, upFor + rng.intBetween(1, 120) * MINUTE);
    offlineCause = isGpon ? rng.pick<OfflineCause>(['DYING GASP', 'ONU LOS']) : null;
  }

  const portUp = state === 'working' && adminState === 'up';
  const vlanBase = world.city === 'Quito' ? 960 : 950;
  const servicePorts: IspServicePort[] = [];
  if (isGpon) {
    servicePorts.push({
      id: 1,
      mode: 'tag',
      vlanIn: vlanBase,
      vlanOut: vlanBase,
      service: 'INT Residencial',
      trafficProfile: `DOWN-RES-${plan.downloadKbps}-I`,
      macLearned: portUp ? 1 : 0,
      state: portUp ? 'up' : 'down',
    });
    if (world.clientServices.phone) {
      servicePorts.push({
        id: 2, mode: 'tag', vlanIn: vlanBase + 1, vlanOut: vlanBase + 1, service: 'VOIP',
        trafficProfile: 'VOIP-1M', macLearned: portUp ? 1 : 0, state: portUp ? 'up' : 'down',
      });
    }
    if (world.clientServices.tv) {
      servicePorts.push({
        id: servicePorts.length + 1, mode: 'tag', vlanIn: vlanBase + 2, vlanOut: vlanBase + 2,
        service: 'IPTV', trafficProfile: 'IPTV-20M', macLearned: portUp ? 1 : 0, state: portUp ? 'up' : 'down',
      });
    }
  }

  const cpes: IspCpe[] = portUp
    ? [{ ip: publicIp(rng), mac: formatMac(client.mac), vendor: client.vendor }]
    : [];

  const device: IspDevice = {
    serial: client.ispId,
    model: client.model,
    version: client.version,
    software: client.software,
    state,
    adminState,
    port: world.port,
    accessNetwork: world.accessNetwork,
    headend: world.headend,
    onuId: world.onuId,
    lastOnline,
    lastOffline,
    offlineCause,
    speedMode: isGpon ? 'GPON' : 'DOCSIS 3.1',
    nap: world.clientNap,
    client: {
      accountNumber: world.account,
      name: input.clientName,
      address: clientAddress(rng, world.city),
    },
    servicePorts,
    wanIp: 'DHCP',
    cpes,
    optics: isGpon ? buildOptics(rng, state) : null,
  };

  return {
    simulated: true,
    source: 'ISP_MONITOR',
    technology: world.technology,
    searchRow: {
      serial: client.ispId,
      city: world.city,
      accessNetwork: world.accessNetwork,
      profile: plan.profile,
      accountNumber: world.account,
      accountStatus: input.accountStatus,
      clientName: input.clientName,
    },
    plan,
    device,
    // DOCSIS SOLO en HFC; en GPON nunca.
    docsis: isGpon ? null : buildDocsis(seededRng(`isp:docsis:${world.account}`), state),
  };
}

/**
 * `GET /accounts/:n/isp-monitor/access-network`.
 *
 * TODO(lopdp): en modo real este listado expondría nombres y cuentas de
 * TERCEROS (vecinos de la NAP). Hoy es 100 % simulado; antes de conectarlo a
 * datos reales hay que definir con la operadora la minimización (p. ej. solo
 * el estado por puerto, sin nombre).
 */
export function buildAccessNetwork(input: IspClientInput): IspAccessNetwork {
  const world = buildWorld(input);
  const naps: AccessNap[] = world.naps.map(({ nap, devices }) => {
    const clean: AccessDevice[] = devices.map((d) => ({
      serial: d.serial,
      accountNumber: d.accountNumber,
      services: d.services,
      clientName: d.clientName,
      accountStatus: d.accountStatus,
      state: d.state,
      isClient: d.isClient,
    }));
    return { nap, summary: napSummary(clean), devices: clean };
  });
  const totals = naps.reduce(
    (acc, x) => ({
      devices: acc.devices + x.summary.total,
      working: acc.working + x.summary.working,
      lost: acc.lost + x.summary.lost,
    }),
    { devices: 0, working: 0, lost: 0 },
  );
  return {
    simulated: true,
    accessNetwork: world.accessNetwork,
    technology: world.technology,
    clientNap: world.clientNap,
    naps,
    totals,
    diagnosis: diagnoseAccessNetwork(naps, {
      accessNetwork: world.accessNetwork,
      technology: world.technology,
    }),
  };
}
