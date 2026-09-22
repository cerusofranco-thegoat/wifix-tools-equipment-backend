// Conector FSM en modo `fixture` (CONNECTOR_MODE_FSM=fixture).
//
// Lo que estos tests protegen:
//   1. La cuenta de los fixtures (35070291) devuelve los datos REALES grabados,
//      pasados por el mismo `normalize.ts` que el modo real.
//   2. Ninguna respuesta lleva marcadores `«REDACTADO:n»` en pantalla: la PII se
//      rehidrata con datos demo deterministas.
//   3. Cualquier otra cuenta / NAP / orden se delega al mock, sin perder el
//      determinismo por semilla.
//   4. CERO red: el conector no hace una sola petición saliente.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFetchSpy, type FetchSpy } from '../helpers/fsm-app.js';
import { env } from '../../src/config/env.js';
import { fsmMock, getFsmConnector } from '../../src/connectors/fsm/index.js';
import {
  createFsmFixtureConnector,
  demoAccountNumber,
  rehydrateFixture,
  resetFsmFixtureCache,
  FIXTURE_ACCOUNT,
} from '../../src/connectors/fsm/fixture.js';
import { resetNapRegistry, type FsmConnector } from '../../src/connectors/fsm/shared.js';

const BRAND = { brand: 'telenews' } as const;
/** Domicilio del cliente del fixture (coordenada real de la captura). */
const FIXTURE_COORDS = { latitude: -2.0761, longitude: -79.8537 };
/** Orden de trabajo cuyas tareas están grabadas en `chain-tasks.json`. */
const FIXTURE_WORK_ORDER = 'ORDER/73198/2019';
/** NAP cuyos puertos están grabados en `chain-nap-accounts.json`. */
const FIXTURE_NAP_ID = 35874;
/**
 * Cuentas REALES de otros abonados que trae `chain-nap-accounts.json` (ese
 * campo no viene redactado). Ninguna puede salir del conector.
 */
const REAL_NAP_ACCOUNTS = ['17412837', '33928054', '102069038', '108913107'];

let connector: FsmConnector;
let spy: FetchSpy | null = null;

beforeEach(() => {
  resetFsmFixtureCache();
  resetNapRegistry();
  connector = createFsmFixtureConnector(fsmMock);
  // Si algo intentara salir a la red, este doble lo registra (y no sale nada).
  spy = installFetchSpy(() => ({ status: 500, raw: 'ningún test de fixture puede usar la red' }));
});

afterEach(() => {
  spy?.restore();
  spy = null;
  resetNapRegistry();
});

/** Texto plano de una respuesta, para buscar marcadores sin redactar. */
function asText(value: unknown): string {
  return JSON.stringify(value);
}

describe('modo fixture — la cuenta grabada devuelve datos reales rehidratados', () => {
  it('getAccountOrders trae las órdenes del fixture con la PII sustituida', async () => {
    const result = await connector.getAccountOrders(FIXTURE_ACCOUNT, {
      ...BRAND,
      estado: 'Todas',
    });

    expect(result.accountNumber).toBe(FIXTURE_ACCOUNT);
    expect(result.orders.length).toBeGreaterThan(10);
    expect(result.orders.map((o) => o.workOrder)).toContain(FIXTURE_WORK_ORDER);

    // Fechas normalizadas a ISO-8601 UTC por el mismo pipeline del modo real.
    for (const order of result.orders) {
      if (order.createdAt) expect(order.createdAt).toMatch(/Z$/);
    }

    // Identidad rehidratada: un solo cliente, con datos demo verosímiles.
    expect(result.client?.names).toBe('María F. Zambrano C.');
    expect(result.client?.phoneNumber).toMatch(/^09\d{8}$/);
    expect(result.client?.email).toContain('@example.com');
    expect(result.client?.address).toContain('Guayaquil');
    // Las coordenadas NO se tocan: son el dato real de producción.
    expect(result.client?.latitude).toBeLessThan(0);

    expect(asText(result)).not.toContain('REDACTADO');
    expect(spy?.calls).toHaveLength(0);
  });

  it('estado=Pendientes filtra las órdenes finalizadas', async () => {
    const todas = await connector.getAccountOrders(FIXTURE_ACCOUNT, { ...BRAND, estado: 'Todas' });
    const pendientes = await connector.getAccountOrders(FIXTURE_ACCOUNT, {
      ...BRAND,
      estado: 'Pendientes',
    });
    expect(pendientes.orders.every((o) => !o.finished)).toBe(true);
    expect(pendientes.orders.length).toBeLessThanOrEqual(todas.orders.length);
  });

  it('getPreviousVisits ordena de la más reciente a la más antigua, sin notas cargadas', async () => {
    const result = await connector.getPreviousVisits(FIXTURE_ACCOUNT, BRAND);
    expect(result.items.length).toBeGreaterThan(10);
    expect(result.totalOrders).toBe(result.items.length);
    expect(result.items.every((i) => i.notesLoaded === false)).toBe(true);
    const dates = result.items.map((i) => i.occurredAt);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
    expect(asText(result)).not.toContain('REDACTADO');
  });

  it('getWorkOrderTasks devuelve las tareas reales de la orden grabada', async () => {
    const result = await connector.getWorkOrderTasks(FIXTURE_WORK_ORDER, BRAND);
    expect(result.workOrder).toBe(FIXTURE_WORK_ORDER);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.businessKey).toBe('TASK/90932/2019');
    expect(task.finishedAt).toMatch(/Z$/);
    // `lastModifyUser` rehidratado como login de técnico, no como «REDACTADO:45».
    expect(task.closedBy).toMatch(/^[a-z]+$/);
    expect(task.notes.length).toBeGreaterThan(1);
    for (const note of task.notes) {
      expect(note.content).not.toContain('REDACTADO');
      expect(note.content.length).toBeGreaterThan(0);
    }
    expect(asText(result)).not.toContain('REDACTADO');
  });

  it('getUnsatisfactoryTasks recorre las órdenes finalizadas sin salir a la red', async () => {
    const result = await connector.getUnsatisfactoryTasks(FIXTURE_ACCOUNT, {
      ...BRAND,
      limit: 5,
    });
    expect(result.scanned).toBeLessThanOrEqual(5);
    expect(result.totalOrders).toBeGreaterThan(5);
    expect(result.truncated).toBe(true);
    expect(result.degraded?.reason).toBe('TRUNCATED');
    expect(result.items.every((i) => i.result === 'INSATISFACTORIA')).toBe(true);
    expect(asText(result)).not.toContain('REDACTADO');
    expect(spy?.calls).toHaveLength(0);
  });

  it('getAccountStatus devuelve el estado real de la cuenta (A → ACTIVA)', async () => {
    const result = await connector.getAccountStatus(FIXTURE_ACCOUNT, BRAND);
    expect(result).toMatchObject({
      accountNumber: FIXTURE_ACCOUNT,
      status: 'ACTIVA',
      statusCode: 'A',
      statusDescription: 'Activo',
    });
  });

  it('getNearbyNaps sirve las NAPs grabadas si la consulta cae cerca del domicilio', async () => {
    const naps = await connector.getNearbyNaps(FIXTURE_COORDS, {
      ...BRAND,
      meters: 500,
      maxRows: 10,
    });
    expect(naps).toHaveLength(3);
    expect(naps.map((n) => n.napId)).toContain(FIXTURE_NAP_ID);
    expect(naps.every((n) => n.source === 'FSM')).toBe(true);
    expect(naps.every((n) => n.networkName === 'AR7S')).toBe(true);
    // Códigos rehidratados y DISTINTOS entre sí (los tres venían redactados con
    // la misma longitud).
    const codes = naps.map((n) => n.napCode);
    expect(new Set(codes).size).toBe(3);
    expect(asText(naps)).not.toContain('REDACTADO');
    expect(naps[0]!.distanceMeters).toBeLessThanOrEqual(naps[2]!.distanceMeters);
  });

  it('getNapPorts dibuja la rejilla completa de la NAP grabada', async () => {
    // Primero /naps/nearest, para que la NAP quede memorizada con su capacidad.
    await connector.getNearbyNaps(FIXTURE_COORDS, { ...BRAND, meters: 500, maxRows: 10 });
    const ports = await connector.getNapPorts(FIXTURE_NAP_ID, { ...BRAND, withStatus: false });

    expect(ports.napId).toBe(FIXTURE_NAP_ID);
    expect(ports.source).toBe('FSM');
    expect(ports.detailAvailable).toBe(true);
    expect(ports.totalPorts).toBe(8);
    expect(ports.ports).toHaveLength(8);
    expect(ports.occupiedPorts).toBe(4);
    expect(ports.ports.filter((p) => p.occupied).map((p) => p.portNumber)).toEqual([2, 3, 4, 6]);
    // Los equipos son los reales de la captura (no son PII de una persona).
    expect(ports.ports.find((p) => p.portNumber === 2)?.equipmentId).toBe('STGU3C3B1A18');
    expect(ports.statusFanOut).toMatchObject({ supported: true, pendingAccounts: 4 });
  });

  it('las cuentas de OTROS abonados salen pseudonimizadas', async () => {
    const ports = await connector.getNapPorts(FIXTURE_NAP_ID, { ...BRAND, withStatus: false });
    const texto = asText(ports);

    // Los cuatro números de cuenta REALES de chain-nap-accounts.json no pueden
    // aparecer en ninguna respuesta (el JSON del fixture no se toca; esto es
    // capa de presentación).
    for (const real of REAL_NAP_ACCOUNTS) {
      expect(texto).not.toContain(real);
    }

    const cuentas = ports.ports
      .filter((p) => p.occupied)
      .map((p) => p.clientAccountNumber as string);
    expect(cuentas).toHaveLength(4);
    // Verosímiles (8 dígitos), distintas entre sí y ninguna es la cuenta demo.
    expect(cuentas.every((c) => /^\d{8}$/.test(c))).toBe(true);
    expect(new Set(cuentas).size).toBe(4);
    expect(cuentas).not.toContain(FIXTURE_ACCOUNT);
    // El serial del equipo SÍ es el real: no es dato de una persona.
    expect(texto).toContain('STGU3C3B1A18');
  });

  it('la pseudonimización es estable: misma cuenta de entrada, misma de salida', async () => {
    const primera = await connector.getNapPorts(FIXTURE_NAP_ID, { ...BRAND, withStatus: false });
    // Relectura completa de los fixtures y mapa de alias vaciado.
    resetFsmFixtureCache();
    resetNapRegistry();
    const segunda = await createFsmFixtureConnector(fsmMock).getNapPorts(FIXTURE_NAP_ID, {
      ...BRAND,
      withStatus: false,
    });
    expect(segunda.ports.map((p) => p.clientAccountNumber)).toEqual(
      primera.ports.map((p) => p.clientAccountNumber),
    );
  });

  it('la cuenta del propio fixture NO se pseudonimiza', () => {
    expect(demoAccountNumber(FIXTURE_ACCOUNT)).toBe(FIXTURE_ACCOUNT);
    for (const real of REAL_NAP_ACCOUNTS) {
      const alias = demoAccountNumber(real);
      expect(alias).not.toBe(real);
      expect(alias).not.toBe(FIXTURE_ACCOUNT);
    }
  });

  it('getNapPorts con withStatus resuelve estados sin red', async () => {
    const ports = await connector.getNapPorts(FIXTURE_NAP_ID, { ...BRAND, withStatus: true });
    // Las cuentas del NAP no son la del fixture: su estado sale del mock, pero
    // igual queda resuelto (statusPending en false) y sin una sola petición.
    expect(ports.ports.filter((p) => p.occupied).every((p) => p.clientStatus !== null)).toBe(true);
    expect(spy?.calls).toHaveLength(0);
  });

  it('es determinista: dos llamadas idénticas devuelven lo mismo', async () => {
    const a = await connector.getAccountOrders(FIXTURE_ACCOUNT, { ...BRAND, estado: 'Todas' });
    resetFsmFixtureCache();
    const b = await createFsmFixtureConnector(fsmMock).getAccountOrders(FIXTURE_ACCOUNT, {
      ...BRAND,
      estado: 'Todas',
    });
    expect(b).toEqual(a);
  });
});

describe('modo fixture — cualquier otra cuenta se delega al mock', () => {
  const OTHER = '71398253';

  // ⚠ El mock siembra las FECHAS a partir de `Date.now()`, así que dos llamadas
  // en milisegundos distintos no son idénticas campo por campo. Para comprobar
  // la delegación se comparan los datos estables (los que salen solo de la
  // semilla): órdenes, ids de tarea, identidad y contadores.

  it('getAccountOrders de otra cuenta devuelve las órdenes del mock', async () => {
    const viaFixture = await connector.getAccountOrders(OTHER, { ...BRAND, estado: 'Todas' });
    const viaMock = await fsmMock.getAccountOrders(OTHER, { ...BRAND, estado: 'Todas' });
    expect(viaFixture.orders.map((o) => o.workOrder)).toEqual(
      viaMock.orders.map((o) => o.workOrder),
    );
    expect(viaFixture.client?.names).toBe(viaMock.client?.names);
    // Y NO es el cliente del fixture.
    expect(viaFixture.client?.names).not.toBe('María F. Zambrano C.');
    expect(viaFixture.client?.email).not.toContain('maria.zambrano');
  });

  it('getAccountStatus de otra cuenta es el del mock', async () => {
    expect(await connector.getAccountStatus(OTHER, BRAND)).toEqual(
      await fsmMock.getAccountStatus(OTHER, BRAND),
    );
  });

  it('previous-visits y unsatisfactory-tasks de otra cuenta caen al mock', async () => {
    const visits = await connector.getPreviousVisits(OTHER, BRAND);
    const mockVisits = await fsmMock.getPreviousVisits(OTHER, BRAND);
    expect(visits.totalOrders).toBe(mockVisits.totalOrders);
    expect(visits.items.map((i) => i.workOrder)).toEqual(mockVisits.items.map((i) => i.workOrder));

    const unsat = await connector.getUnsatisfactoryTasks(OTHER, { ...BRAND, limit: 5 });
    const mockUnsat = await fsmMock.getUnsatisfactoryTasks(OTHER, { ...BRAND, limit: 5 });
    expect(unsat.scanned).toBe(mockUnsat.scanned);
    expect(unsat.totalOrders).toBe(mockUnsat.totalOrders);
    expect(unsat.truncated).toBe(mockUnsat.truncated);
    expect(unsat.items.map((i) => i.taskId)).toEqual(mockUnsat.items.map((i) => i.taskId));
  });

  it('una orden de trabajo que no está en los fixtures cae al mock', async () => {
    const other = 'ORDER/424900/2026';
    const tasks = await connector.getWorkOrderTasks(other, BRAND);
    const mockTasks = await fsmMock.getWorkOrderTasks(other, BRAND);
    expect(tasks.workOrder).toBe(other);
    expect(tasks.tasks.map((t) => t.taskId)).toEqual(mockTasks.tasks.map((t) => t.taskId));
    expect(tasks.tasks.map((t) => t.notes.map((n) => n.content))).toEqual(
      mockTasks.tasks.map((t) => t.notes.map((n) => n.content)),
    );
  });

  it('unas coordenadas lejanas devuelven las NAPs del mock', async () => {
    // Quito, a cientos de km del domicilio del fixture.
    const quito = { latitude: -0.180653, longitude: -78.467834 };
    const naps = await connector.getNearbyNaps(quito, { ...BRAND, meters: 300, maxRows: 10 });
    expect(naps.map((n) => n.napId)).not.toContain(FIXTURE_NAP_ID);
    expect(naps.every((n) => n.napCode.startsWith('PL'))).toBe(true);
  });

  it('una NAP que no está en los fixtures cae al mock', async () => {
    const ports = await connector.getNapPorts(11547, { ...BRAND, withStatus: false });
    expect(ports.napId).toBe(11547);
    expect(ports.ports.length).toBeGreaterThan(0);
  });

  it('un lote de estados mezcla la cuenta del fixture con cuentas del mock', async () => {
    const batch = await connector.getAccountsStatusBatch(
      [FIXTURE_ACCOUNT, OTHER, OTHER],
      BRAND,
    );
    // Dedupe: tres entradas, dos cuentas.
    expect(batch.requested).toBe(2);
    expect(batch.failed).toBe(0);
    const fixtureItem = batch.items.find((i) => i.accountNumber === FIXTURE_ACCOUNT);
    expect(fixtureItem?.statusCode).toBe('A');
  });
});

describe('rehidratación de la PII redactada', () => {
  it('sustituye los marcadores por datos demo y deja el resto intacto', () => {
    const out = rehydrateFixture({
      data: [
        {
          names: '«REDACTADO:28»',
          email: '«REDACTADO:24»',
          phoneNumber: '«REDACTADO:9»',
          address: '«REDACTADO:97»',
          note: '«REDACTADO:239»',
          latitude: -2.07610103,
          workOrder: 'ORDER/73198/2019',
          creationDate: '2019-02-22 00:59:01',
          nested: { content: '«REDACTADO:50»' },
        },
      ],
      errorCode: 0,
    }) as { data: Array<Record<string, unknown>> };

    const row = out.data[0]!;
    expect(row.names).toBe('María F. Zambrano C.');
    expect(row.email).toBe('maria.zambrano@example.com');
    expect(String(row.phoneNumber)).toMatch(/^09\d{8}$/);
    expect(String(row.address)).toContain('Guayaquil');
    expect(String(row.note).length).toBeGreaterThan(10);
    // Todo lo que la app interpreta queda igual.
    expect(row.latitude).toBe(-2.07610103);
    expect(row.workOrder).toBe('ORDER/73198/2019');
    expect(row.creationDate).toBe('2019-02-22 00:59:01');
    expect(JSON.stringify(out)).not.toContain('REDACTADO');
  });

  it('el mismo campo con la misma longitud da siempre el mismo valor', () => {
    const once = rehydrateFixture({ address: '«REDACTADO:97»' });
    const twice = rehydrateFixture({ address: '«REDACTADO:97»' });
    expect(once).toEqual(twice);
  });

  it('no inventa identificadores fiscales: nada con pinta de cédula o RUC', () => {
    const out = JSON.stringify(
      rehydrateFixture({
        data: [{ names: '«REDACTADO:28»', address: '«REDACTADO:82»', note: '«REDACTADO:339»' }],
      }),
    );
    expect(out).not.toMatch(/\b\d{10}\b/); // cédula
    expect(out).not.toMatch(/\b\d{13}\b/); // RUC
  });
});

describe('getFsmConnector respeta CONNECTOR_MODE_FSM=fixture', () => {
  it('devuelve el conector de fixtures y siempre el mismo', async () => {
    const original = env.CONNECTOR_MODE_FSM;
    Object.assign(env, { CONNECTOR_MODE_FSM: 'fixture' });
    try {
      const first = getFsmConnector();
      expect(getFsmConnector()).toBe(first);
      const orders = await first.getAccountOrders(FIXTURE_ACCOUNT, { ...BRAND, estado: 'Todas' });
      expect(orders.client?.names).toBe('María F. Zambrano C.');
      expect(spy?.calls).toHaveLength(0);
    } finally {
      Object.assign(env, { CONNECTOR_MODE_FSM: original });
    }
  });
});
