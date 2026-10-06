// Generador DETERMINÍSTICO del contexto de una orden (TYTAN SIMULADO).
//
// Misma orden → mismos datos. Las fechas se anclan al día actual de Ecuador
// (la tarea "Pendiente" es la de HOY), así que dentro de un mismo día la
// respuesta es idéntica byte a byte; al día siguiente solo se corren las fechas.
//
// Estilo de los datos: el de las órdenes FSM reales de Xtrim (tipos de tarea,
// técnicos "CONN-154 GYE MIGRA | APELLIDOS NOMBRES", materiales con código
// entre corchetes, notas de cierre "CTO: … NIVELES EN EL PUNTO …"). Nada sale
// de FSM ni de la operadora: es 100 % inventado. Función pura.
//
// TODO(tytan-real): sustituir por la orden real de TYTAN (cabecera, tareas,
// cierres, materiales y equipos aprovisionados) cuando haya endpoint.

import { seededRng, type SeededRng } from '../../connectors/_shared.js';
import type { LookupAccount } from '../account-lookup/account-lookup.service.js';
import { workOrderParts } from './order-ids.js';

export type OrderType = 'Visita Técnica' | 'Instalación' | 'Migración';
export type Technology = 'HFC' | 'GPON';
export type OrderStatus = 'Realizado' | 'Cancelado' | 'Pendiente' | 'En curso';
export type TaskStatus = 'Realizado' | 'Cancelado' | 'Pendiente';

export interface OrderMaterial {
  name: string;
  type: 'Material';
  quantity: number;
}

export interface OrderTaskClosure {
  result: 'Satisfactoria' | 'Insatisfactoria';
  reason: string;
  notes: string;
  materials: OrderMaterial[];
}

export interface OrderTask {
  taskId: string;
  taskType: string;
  status: TaskStatus;
  doneFrom: string | null;
  doneTo: string | null;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  assignedTo: string | null;
  priority: number;
  closure: OrderTaskClosure | null;
}

export interface OrderEquipment {
  serviceId: string;
  status: string;
  type: string;
  shortName: string;
  productName: string;
  model: string | null;
  serial: string | null;
  mac: string | null;
}

export interface OrderContext {
  simulated: true;
  source: 'TYTAN';
  order: {
    workOrder: string;
    orderType: OrderType;
    technology: Technology;
    status: OrderStatus;
    createdAt: string;
    closedAt: string | null;
    slaAt: string;
    externalSystem: 'TYTAN';
    externalId: string;
    signatureProcess: string;
  };
  client: {
    accountNumber: string;
    fullName: string;
    phones: string[];
    address: string;
    latitude: number;
    longitude: number;
    napCode: string;
    zoneCode: string;
  };
  /** Más reciente primero; la "Pendiente" (si hay) es la de hoy y va primero. */
  tasks: OrderTask[];
  equipment: OrderEquipment[];
  registeredAddress: string;
  observations: string;
}

// --- Catálogos (estilo FSM Xtrim) ------------------------------------------

type City = 'Guayaquil' | 'Quito';

interface Sector {
  parish: string;
  sector: string;
  streets: readonly string[];
}

const SECTORS: Record<City, readonly Sector[]> = {
  Guayaquil: [
    { parish: 'Villamil', sector: 'CENTRO 1 VILLAMIL', streets: ['ABDON CALDERON', 'VILLAMIL', 'PANAMA'] },
    { parish: 'Tarqui', sector: 'URDESA CENTRAL', streets: ['VICTOR EMILIO ESTRADA', 'CIRCUNVALACION SUR', 'GUAYACANES'] },
    { parish: 'Tarqui', sector: 'KENNEDY NORTE', streets: ['AV. FRANCISCO DE ORELLANA', 'JOSE ALAVEDRA TAMA', 'MIGUEL H. ALCIVAR'] },
    { parish: 'Ximena', sector: 'LOS ESTEROS', streets: ['AV. 25 DE JULIO', 'CALLE 17 SE', 'AV. DOMINGO COMIN'] },
    { parish: 'Pascuales', sector: 'BASTION POPULAR BLOQUE 5', streets: ['AV. CASUARINA', 'CALLE 2DA', 'PEATONAL 7'] },
    { parish: 'Febres Cordero', sector: 'CRISTO DEL CONSUELO', streets: ['CALLE 29', 'GOMEZ RENDON', 'LETAMENDI'] },
  ],
  Quito: [
    { parish: 'Iñaquito', sector: 'LA CAROLINA', streets: ['AV. AMAZONAS', 'AV. NACIONES UNIDAS', 'JAPON'] },
    { parish: 'Chillogallo', sector: 'SANTA RITA', streets: ['AV. MARISCAL SUCRE', 'S29', 'OE7D'] },
    { parish: 'Cotocollao', sector: 'LA FLORIDA', streets: ['AV. LA PRENSA', 'JOSE FELIX BARREIRO', 'N61'] },
    { parish: 'Kennedy', sector: 'LA KENNEDY', streets: ['AV. EL INCA', 'LOS NARANJOS', 'N50'] },
  ],
};

/** Caja de coordenadas urbanas plausibles. */
const CITY_BOX: Record<City, { lat: [number, number]; lon: [number, number] }> = {
  Guayaquil: { lat: [-2.24, -2.08], lon: [-79.95, -79.87] },
  Quito: { lat: [-0.3, -0.1], lon: [-78.54, -78.47] },
};

const CITY_TECH_PREFIX: Record<City, string> = { Guayaquil: 'GYE', Quito: 'UIO' };

const TECH_NAMES = [
  'LLANOS SANCHEZ RODNEY ALBERTO',
  'MOREIRA CEDEÑO JOSE LUIS',
  'BAJAÑA TORRES KEVIN ANDRES',
  'QUIMI ROSALES WALTER FABRICIO',
  'PILLAJO CHICAIZA DIEGO ARMANDO',
  'VERA MACIAS JONATHAN XAVIER',
  'TOAPANTA GUAMAN LUIS ALFREDO',
  'ZAMBRANO ALAVA CRISTHIAN JAVIER',
];

const CLIENT_FIRST = ['MARIA', 'JUAN', 'ANDREA', 'CARLOS', 'LUCIA', 'PEDRO', 'GABRIELA', 'JORGE', 'PAOLA', 'LUIS'];
const CLIENT_LAST = ['CEVALLOS', 'MENDOZA', 'SUAREZ', 'RAMIREZ', 'ORTEGA', 'VEGA', 'ANDRADE', 'YEPEZ', 'SALAZAR', 'BURBANO'];

const ORDER_TYPES: ReadonlyArray<{ type: OrderType; weight: number }> = [
  { type: 'Visita Técnica', weight: 0.55 },
  { type: 'Instalación', weight: 0.3 },
  { type: 'Migración', weight: 0.15 },
];

const SIGNATURE_PREFIX: Record<OrderType, string> = {
  'Visita Técnica': 'FSM_VISTEC',
  Instalación: 'FSM_INST',
  Migración: 'FSM_MIGRA',
};

const CREW: Record<OrderType, string> = {
  'Visita Técnica': 'VT',
  Instalación: 'INST',
  Migración: 'MIGRA',
};

const OK_REASONS: Record<OrderType, readonly string[]> = {
  'Visita Técnica': [
    'CAMBIO DE MATERIAL EXTERNO DAÑO POR TERCEROS',
    'CAMBIO DE CONECTORES EN ROSETA',
    'REUBICACION DE EQUIPO DENTRO DEL DOMICILIO',
    'CAMBIO DE EQUIPO DEFECTUOSO',
    'CONFIGURACION DE RED WIFI',
  ],
  Instalación: ['INSTALACION EXITOSA', 'INSTALACION EXITOSA CON EXTENSOR WIFI'],
  Migración: ['MIGRACION EXITOSA HFC A GPON', 'MIGRACION EXITOSA CON CAMBIO DE ACOMETIDA'],
};

const CANCEL_REASONS = [
  'CLIENTE NO SE ENCUENTRA EN DOMICILIO',
  'CLIENTE REPROGRAMA VISITA',
  'ZONA PELIGROSA SIN ACOMPAÑAMIENTO',
  'NAP SIN PUERTOS DISPONIBLES',
  'DIRECCION INCORRECTA',
];

const CANCEL_NOTES = [
  'SE LLAMA AL CLIENTE EN 3 OCASIONES Y NO CONTESTA. SE DEJA CONSTANCIA CON FOTO DE FACHADA.',
  'CLIENTE SOLICITA REPROGRAMAR PARA OTRO DIA POR MOTIVOS PERSONALES.',
  'SE REQUIERE ACOMPAÑAMIENTO DE SUPERVISOR PARA INGRESAR AL SECTOR.',
  'SE ESCALA A PLANTA EXTERNA PARA VALIDACION DE PUERTOS EN NAP.',
];

const OBSERVATIONS: Record<OrderType, readonly string[]> = {
  'Visita Técnica': [
    'CLIENTE REPORTA INTERMITENCIA EN EL SERVICIO DE INTERNET. CONTACTAR ANTES DE LLEGAR.',
    'CLIENTE INDICA LENTITUD EN HORARIO NOCTURNO Y CORTES FRECUENTES DEL WIFI.',
    'SIN SERVICIO DESDE AYER. LUZ LOS EN ROJO SEGUN CLIENTE.',
  ],
  Instalación: [
    'INSTALACION NUEVA. CLIENTE SOLICITA UBICAR EL EQUIPO EN LA SALA.',
    'INSTALACION NUEVA CON EXTENSOR. CASA DE DOS PISOS.',
  ],
  Migración: [
    'MIGRACION DE HFC A GPON. RETIRAR CABLEMODEM Y DEJAR ONT.',
    'MIGRACION PROGRAMADA POR APAGADO DE NODO HFC.',
  ],
};

interface MaterialSpec {
  name: string;
  min: number;
  max: number;
  p: number;
}

const MATERIALS: Record<Technology, readonly MaterialSpec[]> = {
  GPON: [
    { name: 'CABLE DE FIBRA OPTICA 2 FIBRAS COMMSCOPE FLAT DROP ZWP SM. [BKAS03770]', min: 40, max: 220, p: 1 },
    { name: 'CONECTOR SC APC SM PARA FUSION [MIN-CON-033]', min: 2, max: 4, p: 1 },
    { name: 'ROSETA OPTICA 2 PUERTOS SC APC [MIN-ROS-002]', min: 1, max: 1, p: 0.6 },
    { name: 'TEMPLADOR PARA CABLE DROP PLANO [MIN-TEM-004]', min: 2, max: 4, p: 0.5 },
    { name: 'GRAPA PLASTICA PARA CABLE DROP [MIN-GRA-010]', min: 10, max: 30, p: 0.5 },
  ],
  HFC: [
    { name: 'CABLE COAXIAL RG6 CON MENSAJERO COMMSCOPE [BKAS01120]', min: 30, max: 150, p: 1 },
    { name: 'CONECTOR RG6 DE COMPRESION [MIN-CON-011]', min: 2, max: 4, p: 1 },
    { name: 'SPLITTER 2 VIAS 5-1002 MHZ [MIN-SPL-002]', min: 1, max: 1, p: 0.4 },
    { name: 'GRAPA PARA CABLE RG6 [MIN-GRA-006]', min: 10, max: 30, p: 0.5 },
  ],
};

// --- Utilidades -------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ECUADOR_OFFSET_MS = 5 * HOUR;

/** Instante UTC de las 00:00 de hoy en Ecuador (UTC-5). */
function ecuadorDayStart(now: Date): number {
  const local = now.getTime() - ECUADOR_OFFSET_MS;
  return Math.floor(local / DAY) * DAY + ECUADOR_OFFSET_MS;
}

function hex(rng: SeededRng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += '0123456789ABCDEF'[rng.intBetween(0, 15)];
  return out;
}

function digits(rng: SeededRng, length: number): string {
  let out = String(rng.intBetween(1, 9));
  for (let i = 1; i < length; i++) out += String(rng.intBetween(0, 9));
  return out;
}

function letters(rng: SeededRng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[rng.intBetween(0, 23)];
  return out;
}

function pickWeighted<T extends { weight: number }>(rng: SeededRng, list: readonly T[]): T {
  let r = rng.next();
  for (const item of list) {
    if (r < item.weight) return item;
    r -= item.weight;
  }
  return list[list.length - 1] as T;
}

function cityFrom(account: LookupAccount, rng: SeededRng): City {
  const city = account.city?.toUpperCase() ?? '';
  if (city.includes('QUITO')) return 'Quito';
  if (city.includes('GUAYAQUIL')) return 'Guayaquil';
  return rng.bool(0.65) ? 'Guayaquil' : 'Quito';
}

function technologyFrom(account: LookupAccount, rng: SeededRng): Technology {
  const text = `${account.businessType ?? ''} ${account.accessType ?? ''}`.toUpperCase();
  if (text.includes('GPON') || text.includes('FTTH') || text.includes('FIBRA')) return 'GPON';
  if (text.includes('HFC') || text.includes('COAX')) return 'HFC';
  return rng.bool(0.6) ? 'GPON' : 'HFC';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// --- Generador ----------------------------------------------------------------

/**
 * Contexto completo de la orden. `workOrder` ya normalizado; `account` es la
 * cuenta que resolvió `resolveOrderAccount` (la misma del lookup por orden).
 */
export function buildOrderContext(workOrder: string, account: LookupAccount, now: Date = new Date()): OrderContext {
  const { year } = workOrderParts(workOrder);
  const rng = seededRng(`tytan:order-context:${workOrder}`);
  const today = ecuadorDayStart(now);

  // Cliente y dirección.
  const city = cityFrom(account, rng);
  const sector = rng.pick(SECTORS[city]);
  const street = rng.pick(sector.streets);
  const crossStreet = rng.pick(sector.streets.filter((s) => s !== street));
  const houseNumber = rng.intBetween(100, 4999);
  const block = city === 'Guayaquil' ? `MZ. ${letters(rng, 1)}` : `CASA ${rng.intBetween(1, 60)}`;
  const address = `${city}, ${sector.parish}, ${sector.sector}, ${houseNumber}, ${street}, ${block}`;
  const box = CITY_BOX[city];
  const latitude = rng.floatBetween(box.lat[0], box.lat[1], 10);
  const longitude = rng.floatBetween(box.lon[0], box.lon[1], 10);
  const zonePrefix = `${letters(rng, 2)}${rng.intBetween(1, 9)}`;
  const napCode = `${zonePrefix}${letters(rng, 2)}${rng.intBetween(1, 9)}`;
  const zoneCode = `${zonePrefix}${letters(rng, 2)}`;
  const generatedName = `${rng.pick(CLIENT_LAST)} ${rng.pick(CLIENT_LAST)} ${rng.pick(CLIENT_FIRST)} ${rng.pick(CLIENT_FIRST)}`;
  // Celular (09 + 8 dígitos) y, a veces, fijo con el código de la ciudad (04 GYE, 02 UIO).
  const areaCode = city === 'Guayaquil' ? '4' : '2';
  const phones = [`09${digits(rng, 8)}`, ...(rng.bool(0.35) ? [`0${areaCode}${digits(rng, 7)}`] : [])];

  // Orden.
  const orderType = pickWeighted(rng, ORDER_TYPES).type;
  const technology: Technology = orderType === 'Migración' ? 'GPON' : technologyFrom(account, rng);
  const taskType = orderType === 'Migración' ? 'Migración HFC a GPON' : `${orderType} ${technology}`;
  const techPrefix = `CONN-${String(rng.intBetween(20, 199)).padStart(3, '0')} ${CITY_TECH_PREFIX[city]} ${CREW[orderType]}`;
  const crew = rng.sample(TECH_NAMES, 3).map((name) => `${techPrefix} | ${name}`);

  // Cadena de tareas (de la más antigua a la más reciente).
  const totalTasks = rng.intBetween(2, 5);
  const pendingToday = rng.bool(0.85);
  const dayOffsets: number[] = [];
  let cursor = pendingToday ? 0 : -rng.intBetween(0, 2);
  for (let i = 0; i < totalTasks; i++) {
    dayOffsets.unshift(cursor);
    cursor -= rng.intBetween(1, 3);
  }

  const earlierStatuses: TaskStatus[] = [];
  for (let i = 0; i < totalTasks - 1; i++) earlierStatuses.push(rng.bool(0.5) ? 'Realizado' : 'Cancelado');
  // Mezcla garantizada cuando hay 2+ tareas anteriores.
  if (earlierStatuses.length >= 2 && new Set(earlierStatuses).size === 1) {
    earlierStatuses[0] = earlierStatuses[0] === 'Realizado' ? 'Cancelado' : 'Realizado';
  }
  const lastStatus: TaskStatus = pendingToday ? 'Pendiente' : rng.bool(0.8) ? 'Realizado' : 'Cancelado';
  // Con una sola tarea anterior y sin pendiente, la mezcla la da la última.
  if (!pendingToday && earlierStatuses.length === 1 && earlierStatuses[0] === lastStatus) {
    earlierStatuses[0] = lastStatus === 'Realizado' ? 'Cancelado' : 'Realizado';
  }
  const statuses = [...earlierStatuses, lastStatus];

  let taskNumber = rng.intBetween(400000, 899999);
  const chronological: Array<OrderTask & { _start: number }> = statuses.map((status, i) => {
    taskNumber += rng.intBetween(1500, 40000);
    const taskId = `TASK/${taskNumber}/${year}`;
    const start = today + (dayOffsets[i] as number) * DAY + rng.intBetween(8, 15) * HOUR + rng.pick([0, 30]) * MINUTE;
    const scheduledFrom = start;
    const scheduledTo = start + 2 * HOUR;
    const assignedTo = rng.pick(crew);
    const priority = status === 'Pendiente' ? 1 : rng.intBetween(1, 3);

    if (status === 'Pendiente') {
      return {
        _start: start,
        taskId,
        taskType,
        status,
        doneFrom: null,
        doneTo: null,
        scheduledFrom: iso(scheduledFrom),
        scheduledTo: iso(scheduledTo),
        assignedTo,
        priority,
        closure: null,
      };
    }

    if (status === 'Cancelado') {
      return {
        _start: start,
        taskId,
        taskType,
        status,
        doneFrom: null,
        doneTo: null,
        scheduledFrom: iso(scheduledFrom),
        scheduledTo: iso(scheduledTo),
        assignedTo,
        priority,
        closure: {
          result: 'Insatisfactoria',
          reason: rng.pick(CANCEL_REASONS),
          notes: rng.pick(CANCEL_NOTES),
          materials: [],
        },
      };
    }

    const doneFrom = start + rng.intBetween(10, 50) * MINUTE;
    const doneTo = doneFrom + rng.intBetween(40, 120) * MINUTE;
    const materials: OrderMaterial[] = MATERIALS[technology]
      .filter((m) => m.p >= 1 || rng.bool(m.p))
      .map((m) => ({ name: m.name, type: 'Material' as const, quantity: rng.intBetween(m.min, m.max) }));
    const cable = materials[0]?.quantity ?? 0;
    const levels =
      technology === 'GPON'
        ? { point: -rng.intBetween(17, 24), nap: -rng.intBetween(13, 16) }
        : { point: rng.intBetween(2, 9), nap: rng.intBetween(10, 15) };
    const cableLabel = technology === 'GPON' ? 'FIBRA DROP' : 'COAXIAL RG6';
    const notes =
      `CTO: ${account.accountNumber} DIRECCIÓN: ${address.toUpperCase()} ` +
      `COORDENADAS: ${longitude},${latitude} ` +
      `NIVELES EN EL PUNTO: ${levels.point} NIVELES EN LA NAP ${levels.nap} ` +
      `NUMERACION DE LA NAP: ${napCode} METRAJE DE CABLEADO ${cableLabel} ${cable} MTS. ` +
      `SE REALIZAN PRUEBAS DE NAVEGACION OK CON CLIENTE.`;

    return {
      _start: start,
      taskId,
      taskType,
      status,
      doneFrom: iso(doneFrom),
      doneTo: iso(doneTo),
      scheduledFrom: iso(scheduledFrom),
      scheduledTo: iso(scheduledTo),
      assignedTo,
      priority,
      closure: { result: 'Satisfactoria', reason: rng.pick(OK_REASONS[orderType]), notes, materials },
    };
  });

  const first = chronological[0] as OrderTask & { _start: number };
  const last = chronological[chronological.length - 1] as OrderTask & { _start: number };
  const createdAt = first._start - rng.intBetween(2, 20) * HOUR;
  const slaAt = createdAt + (orderType === 'Visita Técnica' ? 48 : 72) * HOUR;
  const status: OrderStatus = pendingToday
    ? rng.bool(0.6)
      ? 'En curso'
      : 'Pendiente'
    : (last.status as 'Realizado' | 'Cancelado');
  const closedAt = pendingToday
    ? null
    : last.status === 'Realizado'
      ? (last.doneTo as string)
      : iso(last._start + 2 * HOUR + rng.intBetween(5, 60) * MINUTE);

  // Equipos aprovisionados (2–4): módem/ONT e Internet siempre.
  let serviceId = rng.intBetween(150_000_000, 159_000_000);
  const nextServiceId = (): string => String((serviceId += rng.intBetween(1, 900)));
  const equipment: OrderEquipment[] = [
    technology === 'GPON'
      ? {
          serviceId: nextServiceId(),
          status: 'Aprovisionado',
          type: 'SERVICE CALL+GPON',
          shortName: 'Modem',
          productName: 'Modem',
          model: 'ONT ZTE ZXHN F6600 WIFI 6',
          serial: `ZTEG${hex(rng, 8)}`,
          mac: hex(rng, 12),
        }
      : {
          serviceId: nextServiceId(),
          status: 'Aprovisionado',
          type: 'SERVICE CALL+HFC',
          shortName: 'Modem',
          productName: 'Modem',
          model: 'CABLEMODEM HITRON CODA-4582U',
          serial: `HTRN${digits(rng, 9)}`,
          mac: hex(rng, 12),
        },
    {
      serviceId: nextServiceId(),
      status: 'Aprovisionado',
      type: `INTERNET+${technology}`,
      shortName: 'Internet',
      productName: 'Internet',
      model: null,
      serial: null,
      mac: null,
    },
  ];
  if (rng.bool(0.6)) {
    equipment.push({
      serviceId: nextServiceId(),
      status: 'Aprovisionado',
      type: 'WIFI EXTENDER',
      shortName: 'Extensor WiFi',
      productName: 'WiFi N Plus Ultra',
      model: 'AX3 DUAL CORE WIFI 6 WiFi N Plus Ultra',
      serial: `BWH${digits(rng, 10)}`,
      mac: hex(rng, 12),
    });
  }
  if (rng.bool(0.35)) {
    equipment.push({
      serviceId: nextServiceId(),
      status: 'Aprovisionado',
      type: `TV+${technology}`,
      shortName: 'Decodificador',
      productName: 'Xtrim TV',
      model: 'DECODIFICADOR ANDROID TV ZTE B866V2',
      serial: `ZTEG${hex(rng, 8)}`,
      mac: hex(rng, 12),
    });
  }

  const registeredAddress =
    `${street} ${houseNumber} Y ${crossStreet}, ${sector.sector}, ${sector.parish.toUpperCase()}, ` +
    `${city.toUpperCase()}`;

  return {
    simulated: true,
    source: 'TYTAN',
    order: {
      workOrder,
      orderType,
      technology,
      status,
      createdAt: iso(createdAt),
      closedAt,
      slaAt: iso(slaAt),
      externalSystem: 'TYTAN',
      externalId: String(rng.intBetween(38_000_000, 39_999_999)),
      signatureProcess: `${SIGNATURE_PREFIX[orderType]}/${rng.intBetween(100000, 199999)}/${year}`,
    },
    client: {
      accountNumber: account.accountNumber,
      fullName: account.fullName ?? generatedName,
      phones,
      address,
      latitude,
      longitude,
      napCode,
      zoneCode,
    },
    tasks: chronological
      .slice()
      .reverse()
      .map(({ _start, ...task }) => task),
    equipment,
    registeredAddress,
    observations: rng.pick(OBSERVATIONS[orderType]),
  };
}
