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
 *   PERMITIDO  — rangos LAN privados RFC 1918 (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
 *                e IPv6 LAN: ULA (fc00::/7), link-local (fe80::/10), y GUA (2000::/3).
 *                Puertos 80 y 443 únicamente. Solo IPs literales (sin DNS).
 *   BLOQUEADO  — Blocklist con prioridad absoluta sobre el allow:
 *                  · Loopback: 127.x.x.x, ::1 y variantes.
 *                  · Any-address: 0.0.0.0, :: y variantes.
 *                  · IMDS de cloud: 169.254.169.254 (AWS/GCP IPv4),
 *                    fd00:ec2::254 (AWS IMDS IPv6, normalizado para cubrir todas las
 *                    notaciones comprimidas y expandidas), hostnames metadata.*
 *                  · Link-local IPv4: 169.254.x.x.
 *                  · Cualquier IPv4 pública (fuera de RFC 1918).
 *                  · Puertos distintos de 80 y 443.
 *                  · Esquemas distintos de http/https.
 *                  · Hostnames textuales (previene DNS rebinding).
 *
 * Nota sobre GUA (Global Unicast Addresses, 2000::/3):
 *   Habilitar GUA implica que el agente puede dirigir el túnel hacia una IPv6
 *   globalmente enrutable. Este riesgo residual es aceptado por decisión de producto
 *   (los CPE de Xtrim con IPv6 pueden exponer su panel en el prefijo global delegado
 *   por el ISP, ya que IPv6 no usa NAT). Los controles complementarios son:
 *     · Blocklist de IMDS/loopback/any con prioridad.
 *     · Solo puertos 80 y 443.
 *     · Solo IPs literales (sin resolución DNS — previene rebinding).
 *     · Rate-limiting de apertura de RemoteSessions.
 *     · Auditoría de cada request proxeado.
 *
 * Nota sobre IPv4-mapped IPv6 (::ffff:x.x.x.x):
 *   Se detecta en sus dos formas posibles tras pasar por URL():
 *     - Dotted-decimal: ::ffff:192.168.1.1  (si el agente envía el raw)
 *     - Hex-pair: ::ffff:c0a8:101           (normalización de URL())
 *   La IPv4 embebida se extrae y se aplica la política IPv4 completa:
 *     · Si la IPv4 es privada RFC 1918 → PERMITIDO.
 *     · Si es loopback, link-local, IMDS o pública → BLOQUEADO.
 *   Decisión de diseño: mapped privado se permite para no forzar al agente a
 *   reformatear la IP cuando el stack de red devuelve la forma mapped.
 *
 * Nota sobre la API URL():
 *   URL() devuelve hostname con corchetes para IPv6: "[::1]", "[::ffff:7f00:1]".
 *   isIPv6() de node:net devuelve false para la forma con corchetes.
 *   Este módulo normaliza el hostname quitando corchetes antes de todas las
 *   comprobaciones.
 *
 * Normalización IPv6:
 *   Para comparar el blocklist de IMDS (fd00:ec2::254) de forma robusta ante cualquier
 *   notación comprimida o expandida, este módulo implementa un normalizador IPv6 puro
 *   (sin I/O) que expande la dirección a sus 8 grupos de 16 bits en hexadecimal
 *   minúscula separados por ':'. El blocklist se almacena en forma normalizada.
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

/**
 * Expande una dirección IPv6 a su forma canónica de 8 grupos de 16 bits
 * en hexadecimal minúscula, separados por ':'.
 * Ejemplos:
 *   "::1"               → "0000:0000:0000:0000:0000:0000:0000:0001"
 *   "fd00:ec2::254"     → "fd00:0ec2:0000:0000:0000:0000:0000:0254"
 *   "2607:f8b0::200e"   → "2607:f8b0:0000:0000:0000:0000:0000:200e"
 *
 * Devuelve null si la entrada no es una IPv6 válida según isIPv6() de node:net,
 * o si tiene más de 8 grupos (malformada).
 *
 * Implementación pura sin dependencias externas ni I/O.
 */
function expandIPv6(ip: string): string | null {
  if (!isIPv6(ip)) return null;

  const lower = ip.toLowerCase();

  // Separar en las dos mitades que puede generar '::'
  const halves = lower.split('::');

  let leftGroups: string[];
  let rightGroups: string[];

  if (halves.length === 1) {
    // Sin '::' — debe tener exactamente 8 grupos
    leftGroups = lower.split(':');
    rightGroups = [];
  } else if (halves.length === 2) {
    leftGroups = halves[0] ? halves[0].split(':') : [];
    rightGroups = halves[1] ? halves[1].split(':') : [];
  } else {
    // Más de un '::' — dirección inválida (isIPv6 ya lo filtra, pero defensive)
    return null;
  }

  const totalExplicit = leftGroups.length + rightGroups.length;
  if (totalExplicit > 8) return null;

  const zeroPad = 8 - totalExplicit;
  const middle = Array<string>(zeroPad).fill('0000');

  const allGroups = [...leftGroups, ...middle, ...rightGroups];
  if (allGroups.length !== 8) return null;

  // Normalizar cada grupo a 4 dígitos hex
  return allGroups
    .map((g) => {
      const n = parseInt(g || '0', 16);
      if (isNaN(n) || n < 0 || n > 0xffff) return null;
      return n.toString(16).padStart(4, '0');
    })
    .join(':');
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

/** Devuelve true si la dirección IPv6 es link-local (fe80::/10). */
function isLinkLocalIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // fe80::/10 → primeros 10 bits = 1111111010
  // Los primeros 16 bits son fe80..febf
  // En la práctica el prefijo fe8, fe9, fea, feb cubre fe80::/10
  // Simplificación robusta: primer grupo debe ser fe8x, fe9x, feax o febx
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // forma expandida: fe80:0000:... etc
  const expanded = expandIPv6(ip);
  if (expanded !== null) {
    const firstGroup = parseInt(expanded.slice(0, 4), 16);
    // fe80::/10 → 0xfe80 a 0xfebf
    if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true;
  }
  return false;
}

/** Devuelve true si la dirección IPv6 es any-address (:: y variantes). */
function isAnyAddressIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::') return true;
  if (lower === '0:0:0:0:0:0:0:0') return true;
  const expanded = expandIPv6(ip);
  if (expanded !== null && expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  return false;
}

/**
 * Devuelve true si la dirección IPv6 es ULA (fc00::/7).
 * Cubre fc00::/8 (bit 8 = 0) y fd00::/8 (bit 8 = 1).
 * El primer byte es 0xfc o 0xfd.
 */
function isUlaIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Forma corta: empieza con fc o fd
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Forma expandida: inspeccionar primer byte del primer grupo
  const expanded = expandIPv6(ip);
  if (expanded !== null) {
    const firstGroup = parseInt(expanded.slice(0, 4), 16);
    const firstByte = (firstGroup >> 8) & 0xff;
    if (firstByte === 0xfc || firstByte === 0xfd) return true;
  }
  return false;
}

/**
 * Devuelve true si la dirección IPv6 es GUA (Global Unicast Address, 2000::/3).
 * Los primeros 3 bits son 001, lo que corresponde al rango 2000:: a 3fff::ffff:...
 */
function isGlobalUnicastIPv6(ip: string): boolean {
  const expanded = expandIPv6(ip);
  if (expanded === null) return false;
  const firstGroup = parseInt(expanded.slice(0, 4), 16);
  // 2000::/3 → primeros 3 bits = 001 → rango [0x2000, 0x3fff]
  return firstGroup >= 0x2000 && firstGroup <= 0x3fff;
}

// ---------------------------------------------------------------------------
// Blocklist IPv6 normalizada (comprobada ANTES del allow)
// ---------------------------------------------------------------------------

/**
 * Direcciones IPv6 bloqueadas explícitamente, en forma expandida canónica.
 * Se verifica sobre la dirección normalizada con expandIPv6() para cubrir
 * todas las notaciones (comprimida, expandida, etc.).
 *
 * fd00:ec2::254 es el IMDS IPv6 de AWS. Cae dentro del rango ULA (fd00::/8)
 * que ahora se permite; por tanto debe bloquearse explícitamente aquí,
 * con prioridad sobre el allow.
 */
const BLOCKED_IPV6_NORMALIZED = new Set<string>([
  // Loopback ::1
  '0000:0000:0000:0000:0000:0000:0000:0001',
  // Any-address ::
  '0000:0000:0000:0000:0000:0000:0000:0000',
  // AWS IMDS IPv6: fd00:ec2::254
  'fd00:0ec2:0000:0000:0000:0000:0000:0254',
]);

// ---------------------------------------------------------------------------
// Hostnames bloqueados explícitamente
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  // AWS/GCP/Azure/DO IMDS (IPv4 y hostname)
  '169.254.169.254',
  // AWS IMDS IPv6 — también como string crudo por si no pasa por expandIPv6
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
 *   6. Solo IPv4 privada RFC 1918 es permitida; cualquier IPv4 pública → bloqueada.
 *   7. IPv6 mapped (::ffff:x.x.x.x): desenvuelve y aplica política IPv4 completa.
 *   8. IPv6 nativa:
 *      a. Normalizar con expandIPv6(); si el resultado está en BLOCKED_IPV6_NORMALIZED
 *         → bloqueado (cubre loopback, any-address, IMDS fd00:ec2::254).
 *      b. Si es ULA (fc00::/7) → permitido.
 *      c. Si es link-local (fe80::/10) → permitido.
 *      d. Si es GUA (2000::/3) → permitido.
 *      e. Cualquier otra cosa → bloqueado por defecto.
 *   9. Puerto debe ser 80 o 443.
 *  10. Esquema debe ser http o https.
 *
 * El host devuelto en { allowed: true } es la forma normalizada:
 *   · IPv4: string decimal punto.
 *   · IPv6 nativa: forma expandida de expandIPv6() (8 grupos de 4 hex).
 *   · IPv4-mapped permitida: la IPv4 extraída (sin el prefijo ::ffff:).
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

    // Paso 1: IPv4-mapped — desenvuelve y aplica política IPv4 completa.
    // Esto cubre ::ffff:127.0.0.1 (loopback), ::ffff:169.254.169.254 (IMDS/link-local),
    // ::ffff:192.168.1.1 (privada → permitida), ::ffff:8.8.8.8 (pública → bloqueada).
    const mappedIPv4 = extractIPv4FromMapped(hostname);
    if (mappedIPv4 !== null) {
      if (isLoopbackIPv4(mappedIPv4)) {
        return {
          allowed: false,
          reason: `IPv4-mapped loopback no permitida como targetHost: ${hostname}.`,
        };
      }
      if (isAnyAddressIPv4(mappedIPv4)) {
        return {
          allowed: false,
          reason: `IPv4-mapped any-address no permitida como targetHost: ${hostname}.`,
        };
      }
      if (isLinkLocalIPv4(mappedIPv4)) {
        return {
          allowed: false,
          reason: `IPv4-mapped link-local no permitida como targetHost: ${hostname}.`,
        };
      }
      if (!isPrivateIPv4(mappedIPv4)) {
        return {
          allowed: false,
          reason: `IPv4-mapped con IP pública no permitida. IP embebida: ${mappedIPv4}.`,
        };
      }
      // IPv4-mapped con privada RFC 1918 → permitido. Usamos la IPv4 extraída como host.
      // Validar puerto antes de devolver.
      const portStr = parsed.port;
      const port = portStr ? parseInt(portStr, 10) : scheme === 'https:' ? 443 : 80;
      if (!ALLOWED_PORTS.has(port)) {
        return {
          allowed: false,
          reason: `Puerto no permitido: ${port}. Solo se admiten 80 y 443.`,
        };
      }
      return { allowed: true, host: mappedIPv4, port };
    }

    // Paso 2: IPv6 nativa — blocklist con prioridad absoluta.
    // Normalizar a forma expandida para comparación robusta.
    const expanded = expandIPv6(hostname);
    if (expanded !== null && BLOCKED_IPV6_NORMALIZED.has(expanded)) {
      return {
        allowed: false,
        reason: `Dirección IPv6 bloqueada explícitamente: ${hostname}.`,
      };
    }

    // Paso 3: any-address por string (:: / 0:0:0:0:0:0:0:0) — redundante con blocklist
    // pero defensivo si expandIPv6 devuelve null en algún edge case.
    if (isAnyAddressIPv6(hostname)) {
      return {
        allowed: false,
        reason: `Dirección any-address IPv6 no permitida como targetHost: ${hostname}.`,
      };
    }

    // Paso 4: verificar si cae en un rango permitido.
    if (isUlaIPv6(hostname)) {
      // ULA permitida — el blocklist ya filtró fd00:ec2::254 arriba.
      const portStr = parsed.port;
      const port = portStr ? parseInt(portStr, 10) : scheme === 'https:' ? 443 : 80;
      if (!ALLOWED_PORTS.has(port)) {
        return {
          allowed: false,
          reason: `Puerto no permitido: ${port}. Solo se admiten 80 y 443.`,
        };
      }
      return { allowed: true, host: expanded ?? hostname, port };
    }

    if (isLinkLocalIPv6(hostname)) {
      // Link-local (fe80::/10) permitida.
      const portStr = parsed.port;
      const port = portStr ? parseInt(portStr, 10) : scheme === 'https:' ? 443 : 80;
      if (!ALLOWED_PORTS.has(port)) {
        return {
          allowed: false,
          reason: `Puerto no permitido: ${port}. Solo se admiten 80 y 443.`,
        };
      }
      return { allowed: true, host: expanded ?? hostname, port };
    }

    if (isGlobalUnicastIPv6(hostname)) {
      // GUA (2000::/3) permitida. Ver nota sobre riesgo residual en el JSDoc.
      const portStr = parsed.port;
      const port = portStr ? parseInt(portStr, 10) : scheme === 'https:' ? 443 : 80;
      if (!ALLOWED_PORTS.has(port)) {
        return {
          allowed: false,
          reason: `Puerto no permitido: ${port}. Solo se admiten 80 y 443.`,
        };
      }
      return { allowed: true, host: expanded ?? hostname, port };
    }

    // Paso 5: cualquier otra IPv6 → bloqueada por defecto.
    return {
      allowed: false,
      reason: `Dirección IPv6 fuera de rangos permitidos (ULA fc00::/7, link-local fe80::/10, GUA 2000::/3): ${hostname}.`,
    };
  }

  // Validar puerto (IPv4 privada)
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
