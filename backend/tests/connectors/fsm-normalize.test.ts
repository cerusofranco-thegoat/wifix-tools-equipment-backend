// Mapeo crudo FSM → modelo interno.
//
// ⚠ No hay ni una respuesta real de la operadora: los payloads de estos tests
// están construidos a partir de la documentación (`API-fsm-data-ms.md`) y de la
// colección de Postman. Cuando `probe-fsm-api.ts --save` deje fixtures reales,
// hay que recalibrar los parsers contra ellas.
import { describe, it, expect } from 'vitest';
import {
  classifyTaskResult,
  mapAccountProcess,
  mapAccountStatus,
  mapNapAccounts,
  mapNapNearest,
  mapStatusCode,
  mapWorkOrderTasks,
  toIsoUtc,
} from '../../src/connectors/fsm/normalize.js';

describe('mapStatusCode', () => {
  it('traduce los cinco códigos documentados', () => {
    expect(mapStatusCode('A')).toEqual({ statusCode: 'A', status: 'ACTIVA' });
    expect(mapStatusCode('S')).toEqual({ statusCode: 'S', status: 'SUSPENDIDA' });
    expect(mapStatusCode('T')).toEqual({ statusCode: 'T', status: 'TERMINADA' });
    expect(mapStatusCode('O')).toEqual({ statusCode: 'O', status: 'ORDENADA' });
    expect(mapStatusCode('P')).toEqual({ statusCode: 'P', status: 'PENDIENTE' });
  });

  it('cualquier otro valor (o ausente) es DESCONOCIDA', () => {
    expect(mapStatusCode('Z')).toEqual({ statusCode: null, status: 'DESCONOCIDA' });
    expect(mapStatusCode(null)).toEqual({ statusCode: null, status: 'DESCONOCIDA' });
    expect(mapStatusCode(undefined)).toEqual({ statusCode: null, status: 'DESCONOCIDA' });
  });

  it('acepta minúsculas y espacios', () => {
    expect(mapStatusCode(' a ')).toEqual({ statusCode: 'A', status: 'ACTIVA' });
  });
});

describe('toIsoUtc', () => {
  it('interpreta las fechas sin zona como UTC', () => {
    expect(toIsoUtc('2026-08-14 14:02:00')).toBe('2026-08-14T14:02:00.000Z');
    expect(toIsoUtc('2026-08-14T16:41:00')).toBe('2026-08-14T16:41:00.000Z');
  });

  it('respeta las fechas que ya traen zona', () => {
    expect(toIsoUtc('2026-08-14T16:41:00Z')).toBe('2026-08-14T16:41:00.000Z');
  });

  it('devuelve null ante basura', () => {
    expect(toIsoUtc('ORDER/424900/2026')).toBeNull();
    expect(toIsoUtc(null)).toBeNull();
  });
});

describe('classifyTaskResult — heurístico provisional', () => {
  it('sin finishDate la tarea está PENDIENTE', () => {
    expect(classifyTaskResult({ status: 'ABIERTA', finishedAt: null, notes: [] })).toBe(
      'PENDIENTE',
    );
    expect(
      classifyTaskResult({
        status: 'CERRADA',
        finishedAt: null,
        notes: [{ content: 'insatisfactoria' }],
      }),
    ).toBe('PENDIENTE');
  });

  it('una palabra clave en el status la marca INSATISFACTORIA', () => {
    expect(
      classifyTaskResult({ status: 'RECHAZADA', finishedAt: '2026-08-14T16:41:00.000Z', notes: [] }),
    ).toBe('INSATISFACTORIA');
  });

  it('una palabra clave en las notas también la marca INSATISFACTORIA', () => {
    expect(
      classifyTaskResult({
        status: 'CERRADA',
        finishedAt: '2026-08-14T16:41:00.000Z',
        notes: [
          { content: 'Se revisó el ONT.' },
          { content: 'Cliente no estaba, se REPROGRAMADA la visita.' },
        ],
      }),
    ).toBe('INSATISFACTORIA');
  });

  it('compara sin acentos ni mayúsculas', () => {
    expect(
      classifyTaskResult({
        status: 'CERRADA',
        finishedAt: '2026-08-14T16:41:00.000Z',
        notes: [{ content: 'Visita INSATISFACTÓRIA por falta de material' }],
      }),
    ).toBe('INSATISFACTORIA');
  });

  it('en cualquier otro caso es SATISFACTORIA', () => {
    expect(
      classifyTaskResult({
        status: 'CERRADA',
        finishedAt: '2026-08-14T16:41:00.000Z',
        notes: [{ content: 'Servicio operando con normalidad.' }],
      }),
    ).toBe('SATISFACTORIA');
  });
});

describe('mapAccountProcess', () => {
  const payload = {
    data: [
      {
        names: 'María Cevallos Andrade',
        phoneNumber: '0991234567',
        email: 'maria.cevallos@example.com',
        cpartyId: 'CP-991',
        workOrder: 'ORDER/424900/2026',
        task: 'INSTALACION',
        state: 'FINALIZADA',
        creationDate: '2026-08-14 14:02:00',
        endDate: '2026-08-14 16:41:00',
        externalProcess: 'PROC-1',
        address: 'Av. Amazonas N1234, Quito',
        longitude: -79.904161,
        latitude: -2.247946,
        note: 'Sin novedades',
      },
      {
        names: 'María Cevallos Andrade',
        workOrder: 'ORDER/500000/2026',
        task: 'MANTENIMIENTO',
        state: 'EN PROCESO',
        creationDate: '2026-09-01 09:00:00',
        endDate: null,
      },
    ],
  };

  it('ordena las órdenes por createdAt descendente', () => {
    const { orders } = mapAccountProcess(payload);
    expect(orders.map((o) => o.workOrder)).toEqual(['ORDER/500000/2026', 'ORDER/424900/2026']);
  });

  it('finished = endDate no nulo', () => {
    const { orders } = mapAccountProcess(payload);
    expect(orders[0]!.finished).toBe(false);
    expect(orders[1]!.finished).toBe(true);
    expect(orders[1]!.endedAt).toBe('2026-08-14T16:41:00.000Z');
  });

  it('el cliente sale de la primera fila con datos de identidad', () => {
    const { client } = mapAccountProcess(payload);
    expect(client).toMatchObject({
      names: 'María Cevallos Andrade',
      phoneNumber: '0991234567',
      email: 'maria.cevallos@example.com',
      latitude: -2.247946,
      longitude: -79.904161,
    });
  });

  it('acepta el array desnudo y las respuestas vacías', () => {
    expect(mapAccountProcess(payload.data).orders).toHaveLength(2);
    expect(mapAccountProcess({ data: [] })).toEqual({ client: null, orders: [] });
    expect(mapAccountProcess(null)).toEqual({ client: null, orders: [] });
  });
});

describe('mapWorkOrderTasks', () => {
  it('mapea tareas con notas ordenadas ascendentemente', () => {
    const tasks = mapWorkOrderTasks({
      data: [
        {
          taskId: 'TASK/294328/2026',
          status: 'CERRADA',
          businessKey: 'BK-1',
          createDate: '2026-08-14 14:02:00',
          finishDate: '2026-08-14 16:41:00',
          notes: [
            { createDate: '2026-08-14 16:40:00', content: 'Se reinició ONT.' },
            { createDate: '2026-08-14 14:10:00', content: 'Llegada al domicilio.' },
          ],
        },
      ],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.notes.map((n) => n.content)).toEqual([
      'Llegada al domicilio.',
      'Se reinició ONT.',
    ]);
    expect(tasks[0]!.result).toBe('SATISFACTORIA');
  });

  it('descarta filas sin taskId', () => {
    expect(mapWorkOrderTasks({ data: [{ status: 'CERRADA' }] })).toEqual([]);
  });
});

describe('mapAccountStatus', () => {
  it('lee el objeto documentado', () => {
    expect(mapAccountStatus({ data: { accountId: 71398253, status: 'S', description: 'Suspendido' } })).toEqual(
      { accountNumber: '71398253', statusCode: 'S', statusDescription: 'Suspendido' },
    );
  });

  it('tolera que venga envuelto en un array', () => {
    expect(mapAccountStatus({ data: [{ accountId: 1, status: 'A' }] })?.statusCode).toBe('A');
  });

  it('null si la respuesta no trae objeto', () => {
    expect(mapAccountStatus({ data: [] })).toBeNull();
  });
});

describe('mapNapNearest', () => {
  it('mapea la fila documentada y ordena por distancia', () => {
    const naps = mapNapNearest({
      data: [
        { id: 11548, name: 'PL2KD8', ports: 16, network: 'OLT-GYE-03/1/3', distance: 80, lat: -2.2, lng: -79.9, used: 16 },
        { id: 11547, name: 'PL2KD9', ports: 8, network: 'OLT-GYE-03/1/2', distance: 20, lat: -2.247946, lng: -79.904161, used: 4 },
      ],
    });
    expect(naps.map((n) => n.napId)).toEqual([11547, 11548]);
    expect(naps[0]).toEqual({
      napId: 11547,
      napCode: 'PL2KD9',
      networkName: 'OLT-GYE-03/1/2',
      latitude: -2.247946,
      longitude: -79.904161,
      distanceMeters: 20,
      occupiedPorts: 4,
      totalPorts: 8,
    });
  });
});

describe('mapNapAccounts', () => {
  it('mapea los registros documentados', () => {
    expect(
      mapNapAccounts({
        data: [
          { id: 11547, number: 1, accountId: 35070291, equipmentId: 'ZTEGD52E1A9B' },
          { id: 11547, number: 3, accountId: 71398253, equipmentId: null },
        ],
      }),
    ).toEqual([
      { portNumber: 1, accountNumber: '35070291', equipmentId: 'ZTEGD52E1A9B' },
      { portNumber: 3, accountNumber: '71398253', equipmentId: null },
    ]);
  });
});
