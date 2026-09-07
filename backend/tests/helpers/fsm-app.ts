// App de pruebas SIN base de datos.
//
// Las rutas de integración (client-data, network-diagnostics, tasks-visits,
// integrations) no tocan Postgres: solo hablan con los conectores. Este helper
// permite probarlas sin `docker compose up`, y sobre todo garantiza que los
// tests de FSM no dependan de infraestructura externa.
//
// ⚠ Ningún test puede pegarle a la API real de la operadora: todo es
// producción. `installFetchSpy()` reemplaza `fetch` y falla si alguien intenta
// salir a un host no simulado.

import { buildApp } from '../../src/app.js';
import { signAuthToken } from '../../src/auth/jwt.js';
import { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';

export interface FsmTestContext {
  app: FastifyInstance;
  authHeaders: Record<string, string>;
}

export async function buildFsmTestApp(): Promise<FsmTestContext> {
  const app = await buildApp({ logger: false });
  await app.ready();
  const token = await signAuthToken({
    sub: '11111111-1111-4111-8111-111111111111',
    email: 'fsm-tester@wifix.test',
    name: 'FSM Tester',
  });
  return { app, authHeaders: { authorization: `Bearer ${token}` } };
}

/** JWT sin firma válida: solo nos interesa el `exp` del payload. */
export function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.firma-no-verificada`;
}

/** JWT válido durante `hours` horas (por defecto 12). */
export function futureJwt(hours = 12, extra: Record<string, unknown> = {}): string {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) + hours * 3600,
    iat: Math.floor(Date.now() / 1000),
    azp: 'apim_callcenter_telenews',
    ...extra,
  });
}

/** JWT vencido hace `hours` horas. */
export function expiredJwt(hours = 2): string {
  return makeJwt({
    exp: Math.floor(Date.now() / 1000) - hours * 3600,
    iat: Math.floor(Date.now() / 1000) - (hours + 24) * 3600,
    azp: 'apim_callcenter_telenews',
  });
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  /** Cuerpo crudo, para simular respuestas no-JSON. */
  raw?: string;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FetchSpy {
  calls: FetchCall[];
  restore(): void;
}

type Responder = (call: FetchCall) => FakeResponse | Promise<FakeResponse>;

/**
 * Reemplaza `globalThis.fetch` por un doble que registra cada llamada y
 * responde con lo que diga `responder`. Ninguna petición sale de la máquina.
 */
export function installFetchSpy(responder: Responder): FetchSpy {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  interface FakeInit {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }

  const fake = async (input: unknown, init?: FakeInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key.toLowerCase()] = String(value);
    }
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body) as unknown;
      } catch {
        /* form-urlencoded u otro: se deja como string */
      }
    } else if (body !== null && typeof body === 'object') {
      body = String(body);
    }
    const call: FetchCall = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);

    const result = await responder(call);
    const status = result.status ?? 200;
    const text = result.raw ?? (result.body === undefined ? '' : JSON.stringify(result.body));
    // 204/205/304 no admiten cuerpo en el constructor de Response.
    const noBody = status === 204 || status === 205 || status === 304;
    return new Response(noBody ? null : text, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  globalThis.fetch = fake as unknown as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
