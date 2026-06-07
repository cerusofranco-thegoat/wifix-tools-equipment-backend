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
 *   PERMITIDO  — rangos LAN privados RFC 1918 (192.168.x.x, 10.x.x.x,
 *                172.16-31.x.x); puertos 80 y 443 únicamente.
 *   BLOQUEADO  — loopback (127.x.x.x, ::1 y formas alternas), link-local
 *                (169.254.x.x, fe80::/10), localhost como hostname,
 *                any-address (0.0.0.0, ::), cualquier IP pública o no LAN,
 *                cualquier puerto distinto de 80/443.
 *
 * Nota sobre IPv6:
 *   IPv6 privada (fc00::/7, ULA) está intencionalmente NO soportada.
 *   Los CPE de Xtrim usan IPv4 LAN; soportar IPv6 ULA ampliaría la
 *   superficie de ataque sin beneficio operacional.
 *
 *   IPv4-mapped IPv6 (::ffff:x.x.x.x) se detecta explícitamente en sus dos
 *   formas posibles tras pasar por URL():
 *     - Dotted-decimal: ::ffff:127.0.0.1  (si el agente envía el raw)
 *     - Hex-pair: ::ffff:7f00:1          (normalización de URL())
 *   La IPv4 embebida se extrae y se aplica la política IPv4 completa.
 *   En la práctica siempre se bloquea, ya que el agente debe usar IPv4 directa.
 *
 * Nota sobre la API URL():
 *   URL() devuelve hostname con corchetes para IPv6: "[::1]", "[::ffff:7f00:1]".
 *   isIPv6() de node:net devuelve false para la forma con corchetes.
 *   Este módulo normaliza el hostname quitando corchetes antes de todas las
 *   comprobaciones.
 *
 * Módulo sin I/O → testeable sin BD.
 */

import { isIPv4, isIPv6 } from 'node:net';

// ---------------------------------------------------------------------------
// Utilidades de normalización
// ---------------------------------------------------------------------------

/**
 * Elimina los corchetes de una dirección IPv6 tal como la devuelve URL().
 * URL() almacena las IPv6 como "[::1]"; isIPv6() solo acepta "::1".
 */
function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

// ---------------------------------------------------------------------------
// Rangos LAN privados permitidos (RFC 1918)
// ---------------------------------------------------------------------------

/** Devuelve true si la IP IPv4 está en un rango LAN privado (RFC 1918). */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;                            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;              // 192.168.0.0/16
  return false;
}

/** Devuelve true si la IP IPv4 es loopback (127.x.x.x). */
function isLoopbackIPv4(ip: string): boolean {
  return ip.startsWith('127.');
}

/** Devuelve true si la IP IPv4 es link-local (169.254.x.x). */
function isLinkLocalIPv4(ip: string): boolean {
  return ip.startsWith('169.254.');
}

/** Devuelve true si la IP IPv4 es any-address (0.0.0.0). */
function isAnyAddressIPv4(ip: string): boolean {
  return ip === '0.0.0.0';
}

// ---------------------------------------------------------------------------
// Extracción de IPv4 embebida en direcciones IPv4-mapped IPv6
// ---------------------------------------------------------------------------

/**
 * Intenta extraer la IPv4 embebida en una dirección IPv4-mapped IPv6.
 *
 * Reconoce DOS formas, ambas con prefijo ::ffff: (RFC 4291 §2.5.5.2):
 *   1. Dotted-decimal: "::ffff:127.0.0.1"  (input del agente sin pasar por URL)
 *   2. Hex-pair: "::ffff:7f00:1"           (normalización de URL() para [::ffff:127.0.0.1])
 *
 * Devuelve la IPv4 como string ("127.0.0.1") si es mapped; null si no lo es.
 */
function extractIPv4FromMapped(ip: string): string | null {
  const lower = ip.toLowerCase();

  if (!lower.startsWith('::ffff:')) return null;

  const rest = ip.slice(7); // quitar "::ffff:"

  // Forma 1: dotted-decimal  ::ffff:127.0.0.1
  if (isIPv4(rest)) {
    return rest;
  }

  // Forma 2: hex-pair  ::ffff:7f00:1  (dos grupos hex separados por ':')
  // URL() normaliza ::ffff:127.0.0.1  a  ::ffff:7f00:1
  const hexParts = rest.split(':');
  if (hexParts.length === 2) {
    const hi = parseInt(hexParts[0]!, 16);
    const lo = parseInt(hexParts[1]!, 16);
    if (!isNaN(hi) && !isNaN(lo)) {
      const b1 = (hi >> 8) & 0xff;
      const b2 = hi & 0xff;
      const b3 = (lo >> 8) & 0xff;
      const b4 = lo & 0xff;
      return `${b1}.${b2}.${b3}.${b4}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Comprobaciones de categoría para IPv6
// ---------------------------------------------------------------------------

/** Devuelve true si la dirección IPv6 es loopback (::1 y variantes). */
function isLoopbackIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped de loopback
  const mapped = extractIPv4FromMapped(ip);
  if (mapped !== null && isLoopbackIPv4(mapped)) return true;
  return false;
}

/** Devuelve true si la dirección IPv6 es link-local (fe80::/10). */
function isLinkLocalIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe80:')) return true;
  // IPv4-mapped de link-local
  const mapped = extractIPv4FromMapped(ip);
  if (mapped !== null && isLinkLocalIPv4(mapped)) return true;
  return false;
}

/** Devuelve true si la dirección IPv6 es any-address (:: y variantes). */
function isAnyAddressIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::') return true;
  if (lower === '0:0:0:0:0:0:0:0') return true;
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
 * Acepta host bare (p.ej. "192.168.1.1"), host:puerto, [::1]:puerto, o URL completa.
 * Siempre devuelve { allowed, ... }; nunca lanza.
 *
 * Reglas (en orden de aplicación):
 *   1. El host no puede ser un hostname bloqueado (localhost, IMDS, etc.).
 *   2. Si no es IP → bloqueado (sin resolución DNS).
 *   3. IPv4 any-address (0.0.0.0) → bloqueado.
 *   4. IPv4 loopback (127.x.x.x) → bloqueado.
 *   5. IPv4 link-local (169.254.x.x) → bloqueado.
 *   6. Si es IPv6: desenvuelve mapped, comprueba loopback/link-local/any-address.
 *      Cualquier IPv6 no-mapped (incl. fc00::/7 ULA) → bloqueado.
 *   7. Solo IPv4 privada RFC 1918 es permitida.
 *   8. Puerto debe ser 80 o 443.
 *   9. Esquema debe ser http o https.
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

  // URL() guarda IPv6 con corchetes: "[::1]". Quitarlos para las comprobaciones.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = stripBrackets(rawHostname);

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

  // --- Comprobaciones IPv4 ---
  if (isIPv4(hostname)) {
    if (isAnyAddressIPv4(hostname)) {
      return {
        allowed: false,
        reason: `Dirección any-address no permitida como targetHost: ${hostname}.`,
      };
    }
    if (isLoopbackIPv4(hostname)) {
      return { allowed: false, reason: `Loopback no permitido como targetHost: ${hostname}.` };
    }
    if (isLinkLocalIPv4(hostname)) {
      return { allowed: false, reason: `Link-local no permitido: ${hostname}.` };
    }
    if (!isPrivateIPv4(hostname)) {
      return {
        allowed: false,
        reason: `Solo se permiten IPs de rangos privados RFC 1918 (10.x, 172.16-31.x, 192.168.x). IP recibida: ${hostname}.`,
      };
    }
    // IPv4 privada válida — continuar a validación de puerto
  } else {
    // --- Comprobaciones IPv6 ---
    // any-address (:: / 0:0:0:0:0:0:0:0)
    if (isAnyAddressIPv6(hostname)) {
      return {
        allowed: false,
        reason: `Dirección any-address IPv6 no permitida como targetHost: ${hostname}.`,
      };
    }
    // loopback (::1, 0:0:0:0:0:0:0:1, ::ffff:127.x.x.x)
    if (isLoopbackIPv6(hostname)) {
      return { allowed: false, reason: `Loopback IPv6 no permitido como targetHost: ${hostname}.` };
    }
    // link-local (fe80::, ::ffff:169.254.x.x)
    if (isLinkLocalIPv6(hostname)) {
      return { allowed: false, reason: `Link-local IPv6 no permitido: ${hostname}.` };
    }
    // IPv4-mapped: desenvuelve y re-aplica política IPv4
    const mappedIPv4 = extractIPv4FromMapped(hostname);
    if (mappedIPv4 !== null) {
      return {
        allowed: false,
        reason: `IPv4-mapped IPv6 no permitida. Use la dirección IPv4 directamente: ${mappedIPv4}.`,
      };
    }
    // Cualquier otra IPv6 (::1 ya capturado, fc00::/7 ULA, etc.) → bloqueado.
    // IPv6 privada (fc00::/7) intencionalmente NO soportada.
    // Los CPE de Xtrim usan IPv4 LAN.
    return {
      allowed: false,
      reason: `Direcciones IPv6 no permitidas como targetHost. Use la dirección IPv4 del equipo.`,
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
