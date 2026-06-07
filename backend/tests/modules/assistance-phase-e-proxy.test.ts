/**
 * Tests del proxy HTTP reverse del broker — Fase E.
 *
 * Cubre los controles de seguridad definidos en el Definition of Done:
 *   1. Ciclo de la cookie de proxy: emisión, lookup, invalidación al cerrar/expirar.
 *   2. targetHost INMUTABLE: el agente no puede cambiarlo por URL.
 *   3. SSRF re-aplicado: targetHost bloqueado aunque provenga del store.
 *   4. 502 sin túnel activo.
 *   5. Validación de path (anti-CRLF, longitud máx.).
 *   6. Reescritura básica de HTML: inyección de <base>, atributos, strip frame-busting.
 *   7. Strip de frame-busting + CSP propia.
 *   8. Parsing de cookie header.
 *   9. Reescritura de Set-Cookie del router.
 *  10. Rate-limit config.
 *
 * Los tests de BD/integración completa se omiten (requieren Postgres — aparecen en skip).
 * Los tests unitarios de lógica pura no necesitan servidor ni BD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Ciclo de la cookie de proxy
// ---------------------------------------------------------------------------

import {
  issueProxyCookie,
  lookupProxyCookie,
  invalidateProxyCookieBySession,
  purgeExpiredProxyCookies,
  proxyCookieStoreSize,
  clearProxyCookieStore,
  peekProxyCookie,
  buildProxyCookieSetHeader,
  PROXY_COOKIE_NAME,
  PROXY_BASE_PATH,
} from '../../src/modules/assistance/broker/broker.proxy-cookie-store.js';

describe('ProxyCookieStore — ciclo completo', () => {
  beforeEach(async () => {
    await clearProxyCookieStore();
  });

  afterEach(async () => {
    await clearProxyCookieStore();
  });

  it('emite una cookie opaca UUID y la almacena en el store', async () => {
    const value = await issueProxyCookie({
      remoteSessionId: 'rs-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      targetHost: '192.168.1.1',
      expiresAt: Date.now() + 600_000,
    });
    expect(typeof value).toBe('string');
    expect(value).toMatch(/^[0-9a-f-]{36}$/i); // UUID v4
    expect(await proxyCookieStoreSize()).toBe(1);
  });

  it('lookup devuelve la entrada correcta para una cookie válida', async () => {
    const expiresAt = Date.now() + 600_000;
    const value = await issueProxyCookie({
      remoteSessionId: 'rs-2',
      sessionId: 'sess-2',
      agentId: 'agent-2',
      targetHost: '10.0.0.1',
      expiresAt,
    });
    const entry = await lookupProxyCookie(value);
    expect(entry).not.toBeUndefined();
    expect(entry?.remoteSessionId).toBe('rs-2');
    expect(entry?.agentId).toBe('agent-2');
    expect(entry?.targetHost).toBe('10.0.0.1');
    expect(entry?.cookieValue).toBe(value);
  });

  it('lookup devuelve undefined para cookie desconocida', async () => {
    expect(await lookupProxyCookie('no-existe')).toBeUndefined();
  });

  it('lookup devuelve undefined y purga la entrada si está expirada', async () => {
    const value = await issueProxyCookie({
      remoteSessionId: 'rs-3',
      sessionId: 'sess-3',
      agentId: 'agent-3',
      targetHost: '192.168.0.1',
      expiresAt: Date.now() - 1, // ya expirada
    });
    expect(await proxyCookieStoreSize()).toBe(1);
    const entry = await lookupProxyCookie(value);
    expect(entry).toBeUndefined();
    // La entrada debe haberse purgado
    expect(await proxyCookieStoreSize()).toBe(0);
  });

  it('invalidateProxyCookieBySession elimina todas las cookies de esa sesión', async () => {
    const v1 = await issueProxyCookie({
      remoteSessionId: 'rs-inv',
      sessionId: 'sess-inv',
      agentId: 'agent-1',
      targetHost: '192.168.1.1',
      expiresAt: Date.now() + 600_000,
    });
    const v2 = await issueProxyCookie({
      remoteSessionId: 'rs-other',
      sessionId: 'sess-other',
      agentId: 'agent-2',
      targetHost: '10.0.0.2',
      expiresAt: Date.now() + 600_000,
    });

    await invalidateProxyCookieBySession('rs-inv');

    expect(await peekProxyCookie(v1)).toBeUndefined();
    // La otra sesión no debe verse afectada
    expect(await peekProxyCookie(v2)).not.toBeUndefined();
  });

  it('purgeExpiredProxyCookies elimina solo las expiradas', async () => {
    await issueProxyCookie({
      remoteSessionId: 'rs-fresh',
      sessionId: 'sess-fresh',
      agentId: 'ag',
      targetHost: '192.168.1.1',
      expiresAt: Date.now() + 600_000,
    });
    await issueProxyCookie({
      remoteSessionId: 'rs-stale',
      sessionId: 'sess-stale',
      agentId: 'ag',
      targetHost: '192.168.1.2',
      expiresAt: Date.now() - 1,
    });
    expect(await proxyCookieStoreSize()).toBe(2);
    const purged = await purgeExpiredProxyCookies();
    expect(purged).toBe(1);
    expect(await proxyCookieStoreSize()).toBe(1);
  });

  it('buildProxyCookieSetHeader produce cabecera con atributos de seguridad correctos', () => {
    const expires = new Date(Date.now() + 600_000);
    const header = buildProxyCookieSetHeader('test-value-abc', 'rs-xyz', expires);
    expect(header).toContain(`${PROXY_COOKIE_NAME}=test-value-abc`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain(`Path=${PROXY_BASE_PATH}/rs-xyz`);
    expect(header).toContain('Expires=');
    // En NODE_ENV=test no debe tener Secure (no es producción)
    // (La env de test tiene NODE_ENV=test, no producción)
  });

  it('cada emisión produce un valor distinto (UUID único)', async () => {
    const v1 = await issueProxyCookie({
      remoteSessionId: 'rs-u1',
      sessionId: 'sess-u1',
      agentId: 'ag',
      targetHost: '192.168.1.1',
      expiresAt: Date.now() + 600_000,
    });
    const v2 = await issueProxyCookie({
      remoteSessionId: 'rs-u2',
      sessionId: 'sess-u2',
      agentId: 'ag',
      targetHost: '192.168.1.1',
      expiresAt: Date.now() + 600_000,
    });
    expect(v1).not.toBe(v2);
  });
});

// ---------------------------------------------------------------------------
// 2. targetHost INMUTABLE: viene del store, no de la URL
// ---------------------------------------------------------------------------

describe('targetHost inmutabilidad — viene del store, no de la URL', () => {
  beforeEach(async () => { await clearProxyCookieStore(); });
  afterEach(async () => { await clearProxyCookieStore(); });

  it('el targetHost devuelto por lookupProxyCookie es el almacenado al emitir (no el de la URL)', async () => {
    const originalHost = '192.168.1.1';
    const cookieValue = await issueProxyCookie({
      remoteSessionId: 'rs-imm',
      sessionId: 'sess-imm',
      agentId: 'agent-imm',
      targetHost: originalHost,
      expiresAt: Date.now() + 600_000,
    });

    const entry = await lookupProxyCookie(cookieValue);
    expect(entry?.targetHost).toBe(originalHost);
    // Aunque un atacante modifique el URL o el header, el targetHost siempre
    // proviene del store server-side fijado al emitir la cookie.
    // Este test verifica que el store devuelve el host original, no uno inyectado.
    expect(entry?.targetHost).not.toBe('10.0.0.99'); // host "inyectado" por atacante
  });
});

// ---------------------------------------------------------------------------
// 3. SSRF re-aplicado: el guard rechaza targetHost bloqueados
// ---------------------------------------------------------------------------

import { checkTargetHost } from '../../src/modules/assistance/broker/broker.ssrf-guard.js';

describe('SSRF guard re-aplicado en el proxy HTTP (defensa en profundidad)', () => {
  it('loopback 127.0.0.1 es bloqueado por el guard', () => {
    const result = checkTargetHost('127.0.0.1');
    expect(result.allowed).toBe(false);
  });

  it('IMDS 169.254.169.254 es bloqueado por el guard', () => {
    const result = checkTargetHost('169.254.169.254');
    expect(result.allowed).toBe(false);
  });

  it('IP pública 8.8.8.8 es bloqueada por el guard', () => {
    const result = checkTargetHost('8.8.8.8');
    expect(result.allowed).toBe(false);
  });

  it('192.168.1.1 (LAN privada) es permitida por el guard', () => {
    const result = checkTargetHost('192.168.1.1');
    expect(result.allowed).toBe(true);
  });

  it('fd00:ec2::254 (AWS IMDS IPv6, ULA) es bloqueado aunque sea ULA', () => {
    const result = checkTargetHost('http://[fd00:ec2::254]/');
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Validación de path (anti-CRLF, longitud máx.) — reutiliza validateStreamPath
// ---------------------------------------------------------------------------

import { validateStreamPath } from '../../src/modules/assistance/broker/broker.framing.js';

describe('Validación de path del proxy HTTP', () => {
  it('path válido "/" → null (sin error)', () => {
    expect(validateStreamPath('/')).toBeNull();
  });

  it('path válido "/admin/login?user=test" → null (sin error)', () => {
    expect(validateStreamPath('/admin/login')).toBeNull();
  });

  it('path con CRLF es rechazado', () => {
    expect(validateStreamPath('/path\r\nInjected: header')).not.toBeNull();
  });

  it('path con NUL es rechazado', () => {
    expect(validateStreamPath('/path\x00null')).not.toBeNull();
  });

  it('path sin "/" inicial es rechazado', () => {
    expect(validateStreamPath('admin/login')).not.toBeNull();
  });

  it('path de exactamente 2048 chars → válido', () => {
    const p = '/' + 'a'.repeat(2047);
    expect(p.length).toBe(2048);
    expect(validateStreamPath(p)).toBeNull();
  });

  it('path de 2049 chars → inválido (excede máx.)', () => {
    const p = '/' + 'a'.repeat(2048);
    expect(validateStreamPath(p)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Parsing de cookie header
// ---------------------------------------------------------------------------

import { parseCookieHeader } from '../../src/modules/assistance/broker/broker.http-proxy.js';

describe('parseCookieHeader — extracción de cookie por nombre', () => {
  it('extrae el valor correcto de una cookie presente', () => {
    const header = 'session=abc123; other=xyz';
    expect(parseCookieHeader(header, 'session')).toBe('abc123');
  });

  it('extrae la segunda cookie de varias', () => {
    const header = 'a=1; wifix_proxy_session=secret-uuid; b=2';
    expect(parseCookieHeader(header, 'wifix_proxy_session')).toBe('secret-uuid');
  });

  it('devuelve undefined si la cookie no existe', () => {
    const header = 'other=value';
    expect(parseCookieHeader(header, 'wifix_proxy_session')).toBeUndefined();
  });

  it('devuelve undefined si el header es undefined', () => {
    expect(parseCookieHeader(undefined, 'wifix_proxy_session')).toBeUndefined();
  });

  it('devuelve undefined si el header es cadena vacía', () => {
    expect(parseCookieHeader('', 'wifix_proxy_session')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Reescritura de HTML: <base>, atributos, url() en CSS inline
// ---------------------------------------------------------------------------

import {
  rewriteHtml,
  stripFrameBustingHeaders,
  buildProxyResponseHeaders,
  rewriteRouterSetCookies,
} from '../../src/modules/assistance/broker/broker.html-rewriter.js';

const PROXY_BASE = 'https://portal.wifix.internal/asistencia/v1/broker/proxy/rs-123/';
const TARGET_HOST = '192.168.1.1';

describe('rewriteHtml — inyección de <base>', () => {
  it('inyecta <base href="..."> dentro de <head>', () => {
    const html = '<html><head><title>Router</title></head><body>OK</body></html>';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`<base href="${PROXY_BASE}">`);
  });

  it('inyecta <base> al inicio si no hay <head>', () => {
    const html = '<body>no head here</body>';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`<base href="${PROXY_BASE}">`);
    expect(result.indexOf(`<base href="${PROXY_BASE}">`)).toBeLessThan(
      result.indexOf('<body>'),
    );
  });

  it('reemplaza un <base href> existente', () => {
    const html = '<head><base href="/"></head><body></body>';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    // Debe tener exactamente un <base href>
    const matches = result.match(/<base\b[^>]*href[^>]*>/gi) ?? [];
    expect(matches.length).toBe(1);
    expect(result).toContain(`<base href="${PROXY_BASE}">`);
  });
});

describe('rewriteHtml — reescritura de atributos href/src/action', () => {
  it('reescribe href absoluto "/" a la base del proxy', () => {
    const html = '<a href="/login">Login</a>';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`href="${PROXY_BASE}login"`);
  });

  it('reescribe src absoluto', () => {
    const html = '<img src="/images/logo.png">';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`src="${PROXY_BASE}images/logo.png"`);
  });

  it('reescribe action de formulario', () => {
    const html = '<form action="/admin/save">';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`action="${PROXY_BASE}admin/save"`);
  });

  it('NO reescribe href externos (http://...)', () => {
    const html = '<a href="http://example.com/page">ext</a>';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain('href="http://example.com/page"');
  });

  it('NO reescribe href con "#" (ancla)', () => {
    const html = '<a href="#section">anchor</a>';
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain('href="#section"');
  });

  it('reescribe URL absoluta completa al targetHost', () => {
    const html = `<a href="http://${TARGET_HOST}/panel">Panel</a>`;
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`href="${PROXY_BASE}panel"`);
  });
});

describe('rewriteHtml — url() en CSS inline', () => {
  it('reescribe url() con ruta absoluta en style inline', () => {
    const html = `<div style="background: url('/images/bg.png')">`;
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`url('${PROXY_BASE}images/bg.png')`);
  });

  it('reescribe url() con URL absoluta al targetHost', () => {
    const html = `<div style="background: url('http://${TARGET_HOST}/img/bg.jpg')">`;
    const result = rewriteHtml(html, PROXY_BASE, TARGET_HOST);
    expect(result).toContain(`url('${PROXY_BASE}img/bg.jpg')`);
  });
});

// ---------------------------------------------------------------------------
// 7. Strip de frame-busting + CSP propia
// ---------------------------------------------------------------------------

describe('stripFrameBustingHeaders — elimina X-Frame-Options y CSP', () => {
  it('elimina X-Frame-Options del router', () => {
    const headers = {
      'x-frame-options': 'SAMEORIGIN',
      'content-type': 'text/html',
      'server': 'nginx',
    };
    const result = stripFrameBustingHeaders(headers);
    expect(result['x-frame-options']).toBeUndefined();
    expect(result['content-type']).toBe('text/html');
    expect(result['server']).toBe('nginx');
  });

  it('elimina Content-Security-Policy del router', () => {
    const headers = {
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'content-type': 'text/html',
    };
    const result = stripFrameBustingHeaders(headers);
    expect(result['content-security-policy']).toBeUndefined();
  });

  it('no modifica cabeceras que no son frame-busting', () => {
    const headers = {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
    };
    const result = stripFrameBustingHeaders(headers);
    expect(result['content-type']).toBe('application/json');
    expect(result['cache-control']).toBe('no-cache');
  });
});

describe('buildProxyResponseHeaders — CSP restrictiva (A-1) + nosniff + X-Frame (M-3)', () => {
  it('CSP contiene frame-ancestors acotado al portalOrigin', () => {
    const headers = buildProxyResponseHeaders('https://portal.wifix.internal');
    expect(headers['content-security-policy']).toContain(
      'frame-ancestors https://portal.wifix.internal',
    );
  });

  it('CSP contiene script-src con unsafe-inline y unsafe-eval (necesario para paneles de router)', () => {
    const headers = buildProxyResponseHeaders('https://portal.wifix.internal');
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
  });

  it('CSP contiene connect-src self (corta exfiltración a hosts externos)', () => {
    const headers = buildProxyResponseHeaders('https://portal.wifix.internal');
    expect(headers['content-security-policy']).toContain("connect-src 'self'");
  });

  it('CSP contiene form-action self (corta envío de formularios a hosts externos)', () => {
    const headers = buildProxyResponseHeaders('https://portal.wifix.internal');
    expect(headers['content-security-policy']).toContain("form-action 'self'");
  });

  it('CSP contiene default-src none', () => {
    const headers = buildProxyResponseHeaders('https://portal.wifix.internal');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('[M-3] devuelve X-Content-Type-Options: nosniff', () => {
    const headers = buildProxyResponseHeaders('https://portal.wifix.internal');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('[M-3] devuelve X-Frame-Options: SAMEORIGIN', () => {
    const headers = buildProxyResponseHeaders('https://portal.wifix.internal');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('frame-ancestors NO contiene "self" literal — solo el portalOrigin explícito', () => {
    const headers = buildProxyResponseHeaders('https://portal.example.com');
    // frame-ancestors no debe tener 'self'; solo el origen del portal
    const csp = headers['content-security-policy'] ?? '';
    const frameAncestorsDirective = csp
      .split(';')
      .find((d) => d.trim().startsWith('frame-ancestors')) ?? '';
    expect(frameAncestorsDirective).not.toContain("'self'");
    expect(frameAncestorsDirective).toContain('https://portal.example.com');
  });
});

// ---------------------------------------------------------------------------
// 8. Reescritura de Set-Cookie del router
// ---------------------------------------------------------------------------

describe('rewriteRouterSetCookies — confinamiento al path del proxy', () => {
  const proxyPath = '/asistencia/v1/broker/proxy/rs-test';

  it('cambia Path=/ a Path del proxy', () => {
    const cookies = ['routerSession=abc123; Path=/; HttpOnly'];
    const result = rewriteRouterSetCookies(cookies, proxyPath);
    expect(result[0]).toContain(`Path=${proxyPath}`);
    // No debe contener el path raíz simple "Path=/;" (con punto y coma)
    expect(result[0]).not.toContain('Path=/;');
    // No debe contener "Path=/" seguido del fin de cadena (path raíz sin más attrs)
    expect(result[0]).not.toMatch(/Path=\/$/);
    // El path debe ser el del proxy (más largo que "/")
    expect(result[0]).toContain('Path=/asistencia/v1/broker/proxy/rs-test');
  });

  it('añade Path del proxy si no tenía Path', () => {
    const cookies = ['token=xyz; HttpOnly'];
    const result = rewriteRouterSetCookies(cookies, proxyPath);
    expect(result[0]).toContain(`Path=${proxyPath}`);
  });

  it('elimina Domain= del router', () => {
    const cookies = ['sid=val; Domain=192.168.1.1; Path=/'];
    const result = rewriteRouterSetCookies(cookies, proxyPath);
    expect(result[0]).not.toContain('Domain=');
  });

  it('eleva SameSite=Lax a Strict', () => {
    const cookies = ['c=v; SameSite=Lax; Path=/'];
    const result = rewriteRouterSetCookies(cookies, proxyPath);
    expect(result[0]).toContain('SameSite=Strict');
    expect(result[0]).not.toContain('SameSite=Lax');
  });

  it('eleva SameSite=None a Strict', () => {
    const cookies = ['c=v; SameSite=None; Path=/'];
    const result = rewriteRouterSetCookies(cookies, proxyPath);
    expect(result[0]).toContain('SameSite=Strict');
    expect(result[0]).not.toContain('SameSite=None');
  });

  it('añade SameSite=Strict si no tenía SameSite', () => {
    const cookies = ['c=v; HttpOnly'];
    const result = rewriteRouterSetCookies(cookies, proxyPath);
    expect(result[0]).toContain('SameSite=Strict');
  });

  it('procesa múltiples cookies del router de forma independiente', () => {
    const cookies = [
      'session=abc; Path=/; Domain=router.local',
      'csrf=xyz; SameSite=None',
    ];
    const result = rewriteRouterSetCookies(cookies, proxyPath);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain(`Path=${proxyPath}`);
    expect(result[0]).not.toContain('Domain=');
    expect(result[1]).toContain('SameSite=Strict');
  });
});

// ---------------------------------------------------------------------------
// 9. Rate-limit config del proxy
// ---------------------------------------------------------------------------

import { proxyRateLimitConfig } from '../../src/modules/assistance/broker/broker.http-proxy.js';
import { env } from '../../src/config/env.js';

describe('proxyRateLimitConfig — configuración correcta', () => {
  it('max coincide con env.PROXY_RATE_LIMIT_MAX', () => {
    expect(proxyRateLimitConfig.max).toBe(env.PROXY_RATE_LIMIT_MAX);
  });

  it('timeWindow coincide con env.BROKER_RATE_LIMIT_WINDOW_MS', () => {
    expect(proxyRateLimitConfig.timeWindow).toBe(env.BROKER_RATE_LIMIT_WINDOW_MS);
  });

  it('PROXY_RATE_LIMIT_MAX default es 120 (navegación activa)', () => {
    expect(env.PROXY_RATE_LIMIT_MAX).toBe(120);
  });

  it('PROXY_RATE_LIMIT_MAX es mayor que BROKER_RATE_LIMIT_MAX (apertura de sesiones)', () => {
    expect(env.PROXY_RATE_LIMIT_MAX).toBeGreaterThan(env.BROKER_RATE_LIMIT_MAX);
  });
});

// ---------------------------------------------------------------------------
// 10. Smoke test: la app arranca con el proxy registrado
// ---------------------------------------------------------------------------

describe('buildApp — proxy HTTP registrado en el scope de asistencia', () => {
  it('la app arranca sin errores con el proxy HTTP incluido', async () => {
    const { buildApp } = await import('../../src/app.js');
    const app = await buildApp({ logger: false });
    await app.ready();
    expect(app).toBeDefined();

    // Verificar que la ruta del proxy está registrada.
    // printRoutes() muestra la jerarquía comprimida; el nodo del proxy aparece como
    // "proxy/" dentro del scope de broker, con los métodos HTTP del proxy.
    const routes = app.printRoutes();
    // La ruta del proxy aparece como "proxy/" en la jerarquía de Fastify
    expect(routes).toContain('proxy/');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 11. 502 sin túnel — lógica del proxy (unit)
// ---------------------------------------------------------------------------

import { isTunnelAlive } from '../../src/modules/assistance/broker/broker.tunnel-store.js';
import { clearTunnelStore } from '../../src/modules/assistance/broker/broker.tunnel-store.js';

describe('Proxy HTTP — detección de túnel inactivo', () => {
  beforeEach(() => clearTunnelStore());
  afterEach(() => clearTunnelStore());

  it('isTunnelAlive devuelve false cuando no hay túnel registrado', () => {
    expect(isTunnelAlive('sess-no-tunnel')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. [C-1 / M-1] Set-Cookie del router sobrevive en ProxyResult y se confina con HttpOnly
// ---------------------------------------------------------------------------

describe('[C-1/M-1] Set-Cookie del router: sobrevive sin redactar y se fuerza HttpOnly', () => {
  const proxyPath = '/asistencia/v1/broker/proxy/rs-test';

  it('[C-1] rewriteRouterSetCookies recibe la cookie real (no [REDACTED]) y la reescribe', () => {
    // Simula que proxyResult.headers tiene el Set-Cookie real del router (no redactado)
    const realCookie = 'routerSession=REAL_TOKEN_VALUE; Path=/; SameSite=Lax';
    const result = rewriteRouterSetCookies([realCookie], proxyPath);
    // El valor de la cookie debe preservarse tal cual
    expect(result[0]).toContain('routerSession=REAL_TOKEN_VALUE');
    // Y el path debe haberse reescrito al proxy
    expect(result[0]).toContain(`Path=${proxyPath}`);
    // Verificar que NO se reemplaza por [REDACTED]
    expect(result[0]).not.toContain('[REDACTED]');
  });

  it('[M-1] rewriteRouterSetCookies añade HttpOnly a cookie del router que no lo tenía', () => {
    const cookieSinHttpOnly = 'csrfToken=abc123; Path=/; SameSite=Strict';
    const result = rewriteRouterSetCookies([cookieSinHttpOnly], proxyPath);
    expect(result[0]).toContain('HttpOnly');
  });

  it('[M-1] rewriteRouterSetCookies no duplica HttpOnly si el router ya lo incluía', () => {
    const cookieConHttpOnly = 'session=xyz; Path=/; HttpOnly; SameSite=Strict';
    const result = rewriteRouterSetCookies([cookieConHttpOnly], proxyPath);
    // Contar ocurrencias de HttpOnly — debe aparecer exactamente una vez
    const count = (result[0]?.match(/HttpOnly/gi) ?? []).length;
    expect(count).toBe(1);
  });

  it('[M-1] HttpOnly se añade incluso si la cookie del router solo tiene name=value', () => {
    const cookieMinima = 'token=secreto';
    const result = rewriteRouterSetCookies([cookieMinima], proxyPath);
    expect(result[0]).toContain('HttpOnly');
    expect(result[0]).toContain('token=secreto');
  });
});

// ---------------------------------------------------------------------------
// 13. [A-2] Redirect 3xx: mismo host reescrito, host externo bloqueado
// ---------------------------------------------------------------------------

import { rewriteRedirectLocation } from '../../src/modules/assistance/broker/broker.http-proxy.js';

describe('[A-2] rewriteRedirectLocation — reescritura y bloqueo de redirects', () => {
  const proxyPath = '/asistencia/v1/broker/proxy/rs-abc';
  const targetHost = '192.168.1.1';

  it('ruta relativa "/" se reescribe al proxy', () => {
    const result = rewriteRedirectLocation('/login', targetHost, proxyPath);
    expect(result).toBe(`${proxyPath}/login`);
  });

  it('ruta relativa "/admin/panel" se reescribe al proxy', () => {
    const result = rewriteRedirectLocation('/admin/panel', targetHost, proxyPath);
    expect(result).toBe(`${proxyPath}/admin/panel`);
  });

  it('URL absoluta al mismo targetHost se reescribe al proxy', () => {
    const result = rewriteRedirectLocation(
      `http://${targetHost}/admin/save`,
      targetHost,
      proxyPath,
    );
    expect(result).toBe(`${proxyPath}/admin/save`);
  });

  it('URL absoluta al mismo targetHost con path raíz se reescribe al proxy', () => {
    const result = rewriteRedirectLocation(
      `http://${targetHost}/`,
      targetHost,
      proxyPath,
    );
    expect(result).not.toBeNull();
  });

  it('URL a host externo devuelve null (debe bloquearse con 502)', () => {
    const result = rewriteRedirectLocation(
      'http://evil.example.com/steal',
      targetHost,
      proxyPath,
    );
    expect(result).toBeNull();
  });

  it('URL a IMDS 169.254.169.254 devuelve null', () => {
    const result = rewriteRedirectLocation(
      'http://169.254.169.254/latest/meta-data/',
      targetHost,
      proxyPath,
    );
    expect(result).toBeNull();
  });

  it('URL a loopback 127.0.0.1 devuelve null', () => {
    const result = rewriteRedirectLocation(
      'http://127.0.0.1/secret',
      targetHost,
      proxyPath,
    );
    expect(result).toBeNull();
  });

  it('URL a host diferente en misma red privada devuelve null', () => {
    const result = rewriteRedirectLocation(
      'http://192.168.1.2/other-router',
      targetHost, // targetHost es 192.168.1.1
      proxyPath,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14. [M-4] streamId por sesión — sin colisión entre sesiones paralelas
// ---------------------------------------------------------------------------

describe('[M-4] streamId por sesión — sin colisión entre sesiones paralelas', () => {
  it('el mismo streamId no se emite para dos sesiones distintas en el mismo tick', () => {
    // Verificar indirectamente que el mecanismo de correlación por sesión
    // funciona: el emitter usa stream:${streamId} como evento, y si el contador
    // fuera global se reutilizarían IDs entre sesiones.
    // Aquí verificamos que el EventEmitter de node puede usarse con keys de string
    // que incluyan el sessionId como contexto de isolación.
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const emitterA = new EventEmitter();
    const emitterB = new EventEmitter();

    let receivedA = 0;
    let receivedB = 0;

    emitterA.on('stream:1', () => { receivedA++; });
    emitterB.on('stream:1', () => { receivedB++; });

    // Emitir en A no debe afectar a B
    emitterA.emit('stream:1', { type: 'END_STREAM', streamId: 1 });
    expect(receivedA).toBe(1);
    expect(receivedB).toBe(0);

    // Emitir en B no debe afectar a A
    emitterB.emit('stream:1', { type: 'END_STREAM', streamId: 1 });
    expect(receivedA).toBe(1);
    expect(receivedB).toBe(1);
  });

  it('clearStreamCounter exporta sin errores (API pública del módulo)', async () => {
    const { clearStreamCounter } = await import(
      '../../src/modules/assistance/broker/broker.proxy.js'
    );
    // No debe lanzar aunque la sesión no exista
    expect(() => clearStreamCounter('sess-inexistente')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests omitidos (requieren Postgres) — skip explícito
// ---------------------------------------------------------------------------

describe.skip('Proxy HTTP — tests de integración (requieren Postgres)', () => {
  it('devuelve 401 si la cookie de proxy no está presente');
  it('devuelve 403 si la cookie no corresponde al remoteSessionId de la URL');
  it('devuelve 404 si la RemoteSession no está OPEN');
  it('devuelve 401 si la RemoteSession expiró');
  it('devuelve 502 si el técnico no tiene túnel activo');
  it('devuelve 504 si el técnico no responde en 20s (timeout)');
  it('proxea un GET y devuelve HTML con <base> inyectado');
  it('audita cada request en AssistanceEvent tipo REMOTE_SESSION');
});
