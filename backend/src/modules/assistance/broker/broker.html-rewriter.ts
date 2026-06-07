/**
 * Reescritura de HTML para el proxy HTTP del broker.
 *
 * Propósito:
 *   Los paneles de administración de routers contienen referencias a recursos con
 *   URLs relativas o absolutas (href, src, action, CSS url()). Cuando el agente
 *   navega el panel a través del proxy, esas URLs deben resolver contra la base
 *   del proxy, no contra el origen del portal del Call Center.
 *
 * Estrategia:
 *   1. Inyectar `<base href="<proxyBase>">` en el <head> como primera línea de
 *      defensa — los navegadores modernos respetan el tag <base> para todos los
 *      recursos relativos del documento.
 *   2. Reescribir explícitamente href/src/action y url() en CSS inline para
 *      cubrir paneles que ignoran o sobrescriben <base> con JS.
 *   3. Strip de headers frame-busting del router (X-Frame-Options, CSP
 *      frame-ancestors) e inyección de CSP propia que permite el iframe SOLO
 *      desde el origen del portal.
 *
 * Limitaciones conocidas (documentadas, no se intentan resolver):
 *   - Paneles que construyen URLs en JavaScript dinámico (fetch(path), window.location =
 *     '/login', xhr.open('GET', relativeUrl)) pueden no resolver correctamente.
 *     El tag <base> ayuda con navegación declarativa; el JS que muta URLs en runtime
 *     requeriría un Service Worker de interceptación que está fuera de alcance.
 *   - Paneles con URLs absolutas que incluyan el hostname del router (http://192.168.x.x/...)
 *     codificadas en JS tampoco se reescriben — habría que inyectar y ejecutar JS
 *     de reescritura en el DOM, lo cual es inviable de forma robusta.
 *   - Paneles con Content-Type: application/xhtml+xml pueden necesitar el tag <base>
 *     en el namespace correcto; solo se maneja text/html.
 *
 * Módulo sin I/O → testeable sin BD ni red.
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Cabeceras de respuesta del router que activan el strip de frame-busting. */
const FRAME_BUSTING_HEADERS = [
  'x-frame-options',
  'content-security-policy',
] as const;

// ---------------------------------------------------------------------------
// Strip de headers frame-busting
// ---------------------------------------------------------------------------

/**
 * Elimina de las cabeceras del router aquellas que impiden el iframe
 * (X-Frame-Options, Content-Security-Policy con frame-ancestors) y las
 * devuelve sin esas entradas. No modifica el objeto original.
 *
 * El proxy añade su propia CSP con frame-ancestors acotada al portal (ver
 * buildProxyResponseHeaders).
 */
export function stripFrameBustingHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (FRAME_BUSTING_HEADERS.includes(key.toLowerCase() as typeof FRAME_BUSTING_HEADERS[number])) {
      continue; // drop
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Construcción de cabeceras de respuesta del proxy
// ---------------------------------------------------------------------------

/**
 * Construye las cabeceras que el proxy añade (o reemplaza) en la respuesta
 * enviada al navegador del agente:
 *   - Content-Security-Policy: restrictiva con default-src 'none' + directivas necesarias
 *     para paneles de router (script-src unsafe-inline/unsafe-eval) + frame-ancestors
 *     acotada al portalOrigin. connect-src 'self' y form-action 'self' cortan
 *     exfiltración a hosts externos (GUA: ADR-0007).
 *   - X-Content-Type-Options: nosniff — evita sniffing de MIME.
 *   - X-Frame-Options: SAMEORIGIN — defensa en profundidad ante browsers sin CSP.
 *
 * Nota para el frontend: el iframe del portal DEBE usar
 *   sandbox="allow-scripts allow-forms allow-same-origin"
 * para que los paneles de router funcionen correctamente dentro del iframe.
 *
 * @param portalOrigin  El origen del portal (p.ej. "https://portal.wifix.internal").
 *                      Configurable mediante PORTAL_ORIGIN en env.ts.
 */
export function buildProxyResponseHeaders(
  portalOrigin: string,
): Record<string, string> {
  // [ALTO-1] CSP restrictiva: paneles de router necesitan unsafe-inline/unsafe-eval
  // en script-src, pero connect-src 'self' y form-action 'self' bloquean exfiltración
  // a hosts externos aunque el router sirva JS malicioso.
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    `frame-ancestors ${portalOrigin}`,
  ].join('; ');

  return {
    'content-security-policy': csp,
    // [MEDIO-3] Defensa en profundidad
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
  };
}

// ---------------------------------------------------------------------------
// Reescritura de Set-Cookie del router
// ---------------------------------------------------------------------------

/**
 * Reescribe las cookies de sesión del router para confinarlas al path del proxy.
 * El objetivo es que las cookies del router NO contaminen el resto del dominio
 * del portal ni sean accesibles desde otros paths.
 *
 * Transformaciones:
 *   - Path=/ → Path=<proxyPath> (acotar al subtree del proxy de esta sesión)
 *   - Si no tiene Path, añadir Path=<proxyPath>
 *   - Eliminar Domain= para evitar que la cookie se envíe a otros subdominios
 *   - Forzar SameSite=Strict si no está presente o es None/Lax
 *
 * @param setCookieHeaders  Array de valores de cabeceras Set-Cookie del router.
 * @param proxyPath         Path base del proxy, p.ej.
 *                          "/asistencia/v1/broker/proxy/<remoteSessionId>"
 * @returns Array reescrito de valores Set-Cookie.
 */
export function rewriteRouterSetCookies(
  setCookieHeaders: string[],
  proxyPath: string,
): string[] {
  return setCookieHeaders.map((header) => rewriteOneSetCookie(header, proxyPath));
}

function rewriteOneSetCookie(header: string, proxyPath: string): string {
  // Las cabeceras Set-Cookie son: name=value; attr1; attr2=val; ...
  // Dividir por '; ' manteniendo el valor intacto (puede tener '=')
  const parts = header.split(/;\s*/);

  // El primer elemento es name=value — lo dejamos intacto
  const nameValue = parts[0] ?? '';
  const attrs: string[] = [];

  let hasPath = false;
  let hasSameSite = false;
  let hasHttpOnly = false;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i]!;
    const lower = attr.toLowerCase();

    if (lower === 'domain' || lower.startsWith('domain=')) {
      // Eliminar Domain para no contaminar otros subdominios
      continue;
    }

    if (lower.startsWith('path=')) {
      hasPath = true;
      // Reemplazar el path con el path del proxy
      attrs.push(`Path=${proxyPath}`);
      continue;
    }

    if (lower === 'samesite=none' || lower === 'samesite=lax') {
      hasSameSite = true;
      // Elevar a Strict
      attrs.push('SameSite=Strict');
      continue;
    }

    if (lower === 'samesite=strict') {
      hasSameSite = true;
    }

    // [MEDIO-1] Detectar HttpOnly para no duplicarlo si ya viene del router
    if (lower === 'httponly') {
      hasHttpOnly = true;
    }

    attrs.push(attr);
  }

  if (!hasPath) {
    attrs.push(`Path=${proxyPath}`);
  }

  if (!hasSameSite) {
    attrs.push('SameSite=Strict');
  }

  // [MEDIO-1] Forzar HttpOnly en toda cookie reescrita del router.
  // Evita que JS del portal lea la cookie de sesión del router.
  if (!hasHttpOnly) {
    attrs.push('HttpOnly');
  }

  return [nameValue, ...attrs].join('; ');
}

// ---------------------------------------------------------------------------
// Reescritura de HTML (inyección de <base> + atributos)
// ---------------------------------------------------------------------------

/**
 * Reescribe el HTML de respuesta del router para que los recursos relativos
 * resuelvan contra la base del proxy.
 *
 * Estrategia (en orden):
 *   1. Inyecta `<base href="<proxyBase>">` como primer hijo de <head>.
 *      Si no hay <head>, lo inyecta antes del primer tag o al inicio.
 *   2. Reescribe href/src/action que sean rutas absolutas del router
 *      (empiezan por '/') para convertirlas en URLs del proxy.
 *   3. Reescribe url() en atributos style inline que contengan rutas absolutas.
 *
 * @param html        HTML original del router.
 * @param proxyBase   URL base completa del proxy incluyendo el trailing slash.
 *                    Ejemplo: "https://portal.wifix.internal/asistencia/v1/broker/proxy/rs-123/"
 * @param targetHost  Host del router (para reescribir URLs absolutas).
 * @returns HTML reescrito.
 */
export function rewriteHtml(
  html: string,
  proxyBase: string,
  targetHost: string,
): string {
  // 1. Inyectar <base href="...">
  let result = injectBaseTag(html, proxyBase);

  // 2. Reescribir href/src/action con rutas absolutas del router
  //    Patrón: (href|src|action)="/<path>" → (href|src|action)="<proxyBase><path>"
  result = rewriteAbsoluteAttributes(result, proxyBase, targetHost);

  // 3. Reescribir url() en style inline con rutas absolutas del router
  result = rewriteInlineStyleUrls(result, proxyBase, targetHost);

  return result;
}

/**
 * Inyecta <base href="..."> como primer hijo de <head>.
 * Si ya existe un tag <base>, lo reemplaza.
 */
function injectBaseTag(html: string, proxyBase: string): string {
  const baseTag = `<base href="${proxyBase}">`;

  // Si ya hay un <base>, reemplazarlo
  const existingBase = /<base\s[^>]*href\s*=[^>]*>/i;
  if (existingBase.test(html)) {
    return html.replace(existingBase, baseTag);
  }

  // Inyectar al inicio del <head>
  const headOpen = /<head\b[^>]*>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (match) => `${match}\n${baseTag}`);
  }

  // Fallback: inyectar al inicio del documento si no hay <head>
  return `${baseTag}\n${html}`;
}

/**
 * Reescribe href/src/action que sean rutas absolutas (empiezan por '/').
 * Convierte: href="/css/main.css" → href="<proxyBase>css/main.css"
 * No toca: href="http://...", href="https://...", href="#...", href="javascript:..."
 * También reescribe URLs absolutas completas al targetHost.
 */
function rewriteAbsoluteAttributes(
  html: string,
  proxyBase: string,
  targetHost: string,
): string {
  // Construir patrón de URL completa del router para reescribirlas también
  const escapedHost = targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Reescribir URLs absolutas completas al targetHost:
  // href="http://192.168.1.1/path" → href="<proxyBase>path"
  const fullUrlPattern = new RegExp(
    `(\\b(?:href|src|action)\\s*=\\s*["'])https?://${escapedHost}(/[^"']*)`,
    'gi',
  );
  let result = html.replace(fullUrlPattern, (_match, prefix: string, path: string) => {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${prefix}${proxyBase}${cleanPath}`;
  });

  // Reescribir rutas absolutas (empiezan por '/', no por '//')
  // href="/path" → href="<proxyBase>path"
  // Excluir href="//" (protocol-relative), href="javascript:", href="#"
  const absPathPattern = /(\b(?:href|src|action)\s*=\s*["'])(\/(?!\/)[^"']*)/gi;
  result = result.replace(absPathPattern, (_match, prefix: string, path: string) => {
    const cleanPath = path.slice(1); // quitar el '/' inicial
    return `${prefix}${proxyBase}${cleanPath}`;
  });

  return result;
}

/**
 * Reescribe url() en atributos style inline que contengan rutas absolutas.
 * Ejemplo: style="background: url('/images/bg.png')" →
 *          style="background: url('<proxyBase>images/bg.png')"
 */
function rewriteInlineStyleUrls(
  html: string,
  proxyBase: string,
  targetHost: string,
): string {
  // Patrón para url() dentro de atributos style="..."
  // Captura url('...') o url("...") o url(...) sin comillas
  const escapedHost = targetHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const urlPattern = /url\(\s*(['"]?)(\/(?!\/)[^)'"]*)\1\s*\)/gi;
  let result = html.replace(urlPattern, (_match, quote: string, path: string) => {
    const cleanPath = path.slice(1);
    return `url(${quote}${proxyBase}${cleanPath}${quote})`;
  });

  // También URL absolutas al targetHost dentro de url()
  const fullUrlPattern = new RegExp(
    `url\\(\\s*(['"]?)https?://${escapedHost}(/[^)'"]*?)\\1\\s*\\)`,
    'gi',
  );
  result = result.replace(fullUrlPattern, (_match, quote: string, path: string) => {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `url(${quote}${proxyBase}${cleanPath}${quote})`;
  });

  return result;
}
