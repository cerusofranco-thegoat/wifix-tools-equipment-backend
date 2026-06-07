/**
 * Tests del wrapper de auditoría de conectores.
 * Verifican: redacción de secretos, no rotura ante errores, tipos de salida.
 * Sin base de datos: mockeamos prisma.connectorCallLog.create.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock de Prisma antes de importar el módulo bajo test
// ---------------------------------------------------------------------------

// Creamos el mock antes de que el módulo se cargue con import()
const mockCreate = vi.fn().mockResolvedValue({});

vi.mock('../../src/db/prisma.js', () => ({
  prisma: {
    connectorCallLog: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

// Importar después del mock
const { withConnectorAudit } = await import('../../src/connectors/connector-audit.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withConnectorAudit — redacción de secretos', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({});
  });

  it('redacta campo "password" en request', async () => {
    await withConnectorAudit(
      { connector: 'test', operation: 'op', accountNumber: 'WX-001', actorId: 'user-1' },
      async () => ({ ok: true }),
      { accountNumber: 'WX-001', password: 'super-secret-123' },
    );

    // Esperar a que el fire-and-forget se resuelva
    await new Promise((r) => setTimeout(r, 10));

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const request = callArg.data.request as Record<string, unknown>;
    expect(request['password']).toBe('[REDACTED]');
    expect(request['accountNumber']).toBe('WX-001');
  });

  it('redacta campo "token" en response', async () => {
    await withConnectorAudit(
      { connector: 'test', operation: 'op' },
      async () => ({ token: 'very-secret-token', ticketId: 'TKT-001' }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const response = callArg.data.response as Record<string, unknown>;
    expect(response['token']).toBe('[REDACTED]');
    expect(response['ticketId']).toBe('TKT-001');
  });

  it('redacta campos anidados (nested object) — apiKey y secret', async () => {
    await withConnectorAudit(
      { connector: 'test', operation: 'op' },
      async () => ({
        result: 'ok',
        auth: { apiKey: 'abc123', secret: 'mysecret', username: 'admin' },
      }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const response = callArg.data.response as { auth: Record<string, unknown>; result: string };
    expect(response.auth['apiKey']).toBe('[REDACTED]');
    expect(response.auth['secret']).toBe('[REDACTED]');
    expect(response.auth['username']).toBe('admin'); // no sensible
    expect(response.result).toBe('ok');
  });

  it('redacción es case-insensitive (PASSWORD, ApiKey, SECRET)', async () => {
    await withConnectorAudit(
      { connector: 'test', operation: 'op' },
      async () => ({ ok: true }),
      { PASSWORD: 'abc', ApiKey: 'xyz', SECRET: 'shhh' },
    );

    await new Promise((r) => setTimeout(r, 10));

    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const request = callArg.data.request as Record<string, unknown>;
    expect(request['PASSWORD']).toBe('[REDACTED]');
    expect(request['ApiKey']).toBe('[REDACTED]');
    expect(request['SECRET']).toBe('[REDACTED]');
  });
});

describe('withConnectorAudit — no rompe la operación ante error de auditoría', () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it('si prisma.create falla, la operación devuelve su resultado normalmente', async () => {
    mockCreate.mockRejectedValue(new Error('DB connection lost'));

    const result = await withConnectorAudit(
      { connector: 'test', operation: 'op' },
      async () => ({ data: 42 }),
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(result).toEqual({ data: 42 });
  });

  it('si la función principal lanza, withConnectorAudit re-lanza el error', async () => {
    mockCreate.mockResolvedValue({});

    await expect(
      withConnectorAudit(
        { connector: 'test', operation: 'op', accountNumber: 'WX-001', actorId: 'user-1' },
        async () => {
          throw new Error('Conector no disponible');
        },
      ),
    ).rejects.toThrow('Conector no disponible');
  });

  it('cuando la función falla, la auditoría registra status 500', async () => {
    mockCreate.mockResolvedValue({});

    try {
      await withConnectorAudit(
        { connector: 'test', operation: 'op' },
        async () => {
          throw new Error('Fallo de red');
        },
      );
    } catch {
      // esperado
    }

    await new Promise((r) => setTimeout(r, 10));

    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(callArg.data.status).toBe(500);
  });

  it('cuando la función tiene éxito, la auditoría registra status 200', async () => {
    mockCreate.mockResolvedValue({});

    await withConnectorAudit(
      { connector: 'test', operation: 'op' },
      async () => 'ok',
    );

    await new Promise((r) => setTimeout(r, 10));

    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(callArg.data.status).toBe(200);
  });
});

describe('withConnectorAudit — campos de auditoría', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({});
  });

  it('registra connector, operation, accountNumber y actorId', async () => {
    await withConnectorAudit(
      {
        connector: 'ticketing',
        operation: 'generaTicket',
        accountNumber: 'WX-AUDIT-001',
        actorId: 'user-abc',
      },
      async () => ({ ticketId: 'TKT-001' }),
    );

    await new Promise((r) => setTimeout(r, 10));

    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(callArg.data.connector).toBe('ticketing');
    expect(callArg.data.operation).toBe('generaTicket');
    expect(callArg.data.accountNumber).toBe('WX-AUDIT-001');
    expect(callArg.data.actorId).toBe('user-abc');
  });

  it('registra durationMs como número positivo', async () => {
    await withConnectorAudit(
      { connector: 'test', operation: 'op' },
      async () => 'result',
    );

    await new Promise((r) => setTimeout(r, 10));

    const callArg = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(typeof callArg.data.durationMs).toBe('number');
    expect(callArg.data.durationMs as number).toBeGreaterThanOrEqual(0);
  });
});
