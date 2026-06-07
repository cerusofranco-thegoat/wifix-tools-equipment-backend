/**
 * Guardia SSRF para el broker de sesión remota.
 *
 * Contexto de amenaza:
 *   El agente del Call Center proporciona un targetHost al abrir la sesión remota.
 *   Ese host determina a qué equipo se dirigirá el tráfico del túnel.
 *   Si no se valida, un agente malicioso podría apuntar a:
 *     - La red interna de Wifix (metadata endpoint de cloud, servicios internos)
 *     - El loopback del servidor del broker
 *     - Hosts arbitrarios de Internet
 *
 * Nota de arquitectura (ADR-0002):
 *   El tráfico se resuelve DEL LADO DEL TÉCNICO (en el LAN del cliente), no en el
 *   servidor del broker. Sin embargo, el agente controla el targetHost que se envía
 *   en las tramas OPEN_STREAM al técnico; por tanto la validación es obligatoria
 *   para acotar qué puede solicitar el agente, independientemente de quién resuelve.
 *
 * Política (ver también docs/asistencia-broker-protocolo.md):
 *   PERMITIDO  — rangos LAN privados RFC 1918 / RFC 4193 (192.168.x.x, 10.x.x.x,
 *                172.16-31.x.x); puertos 80 y 443 únicamente.
 *   BLOQUEADO  — loopback (127.x.x.x, ::1), link-local (169.254.x.x, fe80::/10),
 *                localhost como hostname, cualquier IP pública o no LAN,
 *                cualquier puerto distinto de 80/443.
 *
 * Módulo sin I/O → testeable sin BD.
 */

import { isIPv4, isIPv6 } from 'node:net';

// ---------------------------------------------------------------------------
// Rangos LAN privados permitidos (RFC 1918 + loopback excluido)
// ---------------------------------------------------------------------------

/** Devuelve true si la IP IPv4 está en un rango LAN privado (RFC 1918). */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  return false;
}

/** Devuelve true si la IP es loopback. */
function isLoopback(ip: string): boolean {
  if (isIPv4(ip)) {
    return ip.startsWith('127.');
  }
  if (isIPv6(ip)) {
    return ip === '::1' || ip.toLowerCase() === '0:0:0:0:0:0:0:1';
  }
  return false;
}

/** Devuelve true si la IP es link-local (169.254.x.x ó fe80::/10). */
function isLinkLocal(ip: string): boolean {
  if (isIPv4(ip)) {
    return ip.startsWith('169.254.');
  }
  if (isIPv6(ip)) {
    return ip.toLowerCase().startsWith('fe80:');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hostnames bloqueados explícitamente
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  // AWS/GCP/Azure/DO IMDS
  '169.254.169.254',
  'fd00:ec2::254',
]);

// ---------------------------------------------------------------------------
// Puertos permitidos para el panel del router
// ---------------------------------------------------------------------------

const ALLOWED_PORTS = new Set([80, 443]);

// ---------------------------------------------------------------------------
// Esquemas permitidos
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// ---------------------------------------------------------------------------
// Resultado de validación
// ---------------------------------------------------------------------------

export type SsrfCheckResult =
  | { allowed: true; host: string; port: number }
  | { allowed: false; reason: string };

/**
 * Valida un targetHost antes de usarlo en el broker.
 *
 * Acepta host bare (p.ej. "192.168.1.1"), host:puerto, o URL completa.
 * Siempre devuelve { allowed, ... }; nunca lanza.
 *
 * Reglas:
 *   1. El host no puede ser un hostname bloqueado (localhost, IMDS, etc.).
 *   2. Si el host es una IP pública o no LAN privada → bloqueado.
 *   3. Si el host es loopback → bloqueado.
 *   4. Si el host es link-local → bloqueado.
 *   5. Puerto (si se especifica) debe ser 80 o 443.
 *   6. Esquema (si se especifica) debe ser http o https.
 */
export function checkTargetHost(raw: string): SsrfCheckResult {
  if (!raw || raw.trim().length === 0) {
    return { allowed: false, reason: 'targetHost vacío o ausente.' };
  }

  // Normalizar: si no tiene scheme, añadir http:// para poder usar URL()
  let urlStr = raw.trim();
  if (!urlStr.includes('://')) {
    urlStr = `http://${urlStr}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { allowed: false, reason: `targetHost inválido: ${raw}` };
  }

  const scheme = parsed.protocol;
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return {
      allowed: false,
      reason: `Esquema no permitido: ${scheme}. Solo se admite http y https.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Comprobar hostnames bloqueados explícitamente
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `Host bloqueado: ${hostname}.` };
  }

  // Bloquear cualquier hostname textual que no sea una IP
  // (evita resolución de DNS arbitraria que saltaría la allowlist)
  if (!isIPv4(hostname) && !isIPv6(hostname)) {
    return {
      allowed: false,
      reason: `Solo se permiten direcciones IP privadas como targetHost, no hostnames (${hostname}).`,
    };
  }

  if (isLoopback(hostname)) {
    return { allowed: false, reason: `Loopback no permitido como targetHost: ${hostname}.` };
  }

  if (isLinkLocal(hostname)) {
    return { allowed: false, reason: `Link-local no permitido: ${hostname}.` };
  }

  if (!isPrivateIPv4(hostname)) {
    // Para IPv6 privadas (fc00::/7) la política es bloquear por default por simplicidad:
    // los routers domésticos de Xtrim usan IPv4 LAN.
    return {
      allowed: false,
      reason: `Solo se permiten IPs de rangos privados RFC 1918 (10.x, 172.16-31.x, 192.168.x). IP recibida: ${hostname}.`,
    };
  }

  // Validar puerto
  const portStr = parsed.port;
  const port = portStr ? parseInt(portStr, 10) : scheme === 'https:' ? 443 : 80;

  if (!ALLOWED_PORTS.has(port)) {
    return {
      allowed: false,
      reason: `Puerto no permitido: ${port}. Solo se admiten 80 y 443.`,
    };
  }

  return { allowed: true, host: hostname, port };
}

/**
 * Valida el targetHost y devuelve el valor normalizado.
 * Lanza un objeto con shape {code, message} si el host no está permitido,
 * para que el servicio lo convierta en ApiError sin dependencia circular.
 */
export function assertTargetHostAllowed(
  raw: string | null | undefined,
): { ok: true; target: string } | { ok: false; reason: string } {
  const target = raw?.trim() ?? '';
  if (!target) {
    return { ok: true, target: '' };
  }
  const result = checkTargetHost(target);
  if (!result.allowed) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, target };
}
