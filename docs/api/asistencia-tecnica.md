# Contrato de API — Módulo Asistencia Técnica (Wifix)

Ubicación sugerida en el repo: `docs/api/asistencia-tecnica.md`. Esta es la **fuente de verdad**: frontend (app del técnico + portal del Call Center) y backend la respetan; si algo no calza, se cambia aquí primero.

- **Prefijo:** `/asistencia/v1` (consistente con `/herramientas/v1`).
- **Auth:** `Authorization: Bearer <jwt>` en todos los endpoints excepto `/health`. El JWT es el mismo del módulo Herramientas.
- **Roles** (claim `role` en el JWT): `TECHNICIAN`, `AGENT`, `SUPERVISOR`. Donde un endpoint exige rol, se indica.
- **Convención:** campos en `camelCase` (igual que el contrato de Herramientas). Mensajes de error en español, códigos en inglés.
- **Tiempo real:** la señalización va por WebSocket (sección 4). El video va por Jitsi (sección 5). El plano de túnel de la sesión remota se describe a nivel de control aquí; el protocolo de trama se define en la Fase D.

---

## 1. Tipos compartidos (TypeScript)

```ts
type Role = 'TECHNICIAN' | 'AGENT' | 'SUPERVISOR';

type AssistanceStatus =
  | 'REQUESTED' | 'QUEUED' | 'ASSIGNED' | 'ACTIVE' | 'ON_HOLD'
  | 'RESOLVED' | 'UNRESOLVED' | 'CANCELLED' | 'EXPIRED';

type RemoteActionType =
  | 'REBOOT' | 'SET_WIFI' | 'SET_CHANNEL' | 'FACTORY_RESET'
  | 'REPROVISION' | 'RUN_DIAGNOSTIC';

type RemoteActionStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

type RemoteSessionChannel = 'BROKER_TUNNEL' | 'COBROWSE';
type RemoteSessionStatus  = 'OPEN' | 'CLOSED' | 'EXPIRED';

type AssistanceEventType =
  | 'STATE_CHANGE' | 'NOTE' | 'ACTION' | 'REMOTE_SESSION' | 'CHAT' | 'CONSENT';

interface AssistanceSession {
  id: string;
  accountNumber: string;
  visitId: string | null;
  technicianId: string | null;
  agentId: string | null;
  status: AssistanceStatus;
  reason: string | null;
  consentAt: string | null;      // ISO 8601
  requestedAt: string;           // ISO 8601
  closedAt: string | null;
  resolutionNote: string | null;
}

interface AssistanceEvent {
  id: string;
  sessionId: string;
  type: AssistanceEventType;
  payload: Record<string, unknown> | null;
  actorId: string | null;
  createdAt: string;
}

interface RemoteAction {
  id: string;
  sessionId: string;
  accountNumber: string;
  action: RemoteActionType;
  status: RemoteActionStatus;
  request: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  performedBy: string | null;
  createdAt: string;
}

interface RemoteSession {
  id: string;
  sessionId: string;
  channel: RemoteSessionChannel;
  status: RemoteSessionStatus;
  expiresAt: string;
  recordingId: string | null;    // -> MediaFile
  startedAt: string;
  endedAt: string | null;
}

interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
```

Códigos de error (reutilizan los del backend, añadiendo `FORBIDDEN`):

| Código | HTTP | Uso |
|--------|------|-----|
| `VALIDATION_ERROR` | 400 | Cuerpo o parámetros inválidos |
| `UNAUTHORIZED` | 401 | Token/credenciales inválidos |
| `FORBIDDEN` | 403 | Rol insuficiente para la operación |
| `NOT_FOUND` | 404 | Sesión/recurso inexistente |
| `CONFLICT` | 409 | Transición de estado inválida o sesión ya asignada |
| `CONNECTOR_ERROR` | 502 | Fallo de un sistema externo (ACS / operadora) |
| `INTERNAL_ERROR` | 500 | Error no controlado |

---

## 2. Sesiones de asistencia

### Crear solicitud — POST /sessions
Propósito: el técnico abre una solicitud de asistencia para una cuenta.
Auth: requerida — rol `TECHNICIAN`.

Request body (JSON):
```ts
interface CreateSessionBody {
  accountNumber: string;          // obligatorio
  visitId?: string;
  reason?: string;
  consent: boolean;               // consentimiento del cliente capturado en sitio
}
```
Response 201:
```ts
{ session: AssistanceSession }    // status: 'QUEUED', consentAt seteado si consent=true
```
Errores: `400` accountNumber ausente o `consent` falso; `401`.

> El `technicianId` se toma del JWT, ignorando cualquier valor del cuerpo.

### Cola de solicitudes — GET /sessions
Propósito: listar/filtrar solicitudes (cola del Call Center y consultas).
Auth: requerida — `AGENT` o `SUPERVISOR`.

Query params: `status` — `AssistanceStatus` — no — filtra por estado; `accountNumber` — string — no; `page` — int ≥ 1 (default 1); `pageSize` — int 1..100 (default 20).

Response 200: `Paginated<AssistanceSession>` (orden: más recientes/prioritarias primero).
Errores: `401`, `403`.

### Detalle — GET /sessions/{id}
Propósito: detalle de una sesión con su estado, video y sesión remota activa.
Auth: requerida — participantes (técnico de la sesión / agente asignado) o `SUPERVISOR`.

Response 200:
```ts
{
  session: AssistanceSession;
  activeRemoteSession: RemoteSession | null;
  videoRoom: { roomName: string; domain: string } | null;
  recentActions: RemoteAction[];   // últimas N
}
```
Errores: `401`, `403`, `404`.

### Tomar la solicitud — POST /sessions/{id}/assign
Propósito: el agente reclama una solicitud de la cola.
Auth: requerida — `AGENT`.

Response 200: `{ session: AssistanceSession }` (status → `ASSIGNED`, `agentId` del JWT).
Errores: `401`, `403`, `404`, `409` (ya asignada a otro agente).

### Transición de estado — POST /sessions/{id}/status
Propósito: avanzar el ciclo de vida de la sesión (máquina de estados).
Auth: requerida — `AGENT` asignado o `SUPERVISOR`.

Request body (JSON):
```ts
interface ChangeStatusBody {
  status: 'ACTIVE' | 'ON_HOLD' | 'RESOLVED' | 'UNRESOLVED' | 'CANCELLED';
  note?: string;                  // obligatorio para RESOLVED/UNRESOLVED/CANCELLED
}
```
Transiciones válidas:
```
ASSIGNED → ACTIVE
ACTIVE ⇄ ON_HOLD
ACTIVE → RESOLVED | UNRESOLVED
{REQUESTED|QUEUED|ASSIGNED|ACTIVE|ON_HOLD} → CANCELLED
(EXPIRED lo setea el sistema por timeout, no por este endpoint)
```
Response 200: `{ session: AssistanceSession }`.
Errores: `400` falta `note` cuando se exige; `401`; `403`; `404`; `409` transición inválida.

### Timeline — GET /sessions/{id}/events
Propósito: auditoría/cronología de la sesión.
Auth: requerida — participantes o `SUPERVISOR`.
Query: `page`, `pageSize` (como arriba).
Response 200: `Paginated<AssistanceEvent>` (orden cronológico).
Errores: `401`, `403`, `404`.

### Nota — POST /sessions/{id}/notes
Propósito: registrar una nota en el timeline.
Auth: requerida — participantes o `SUPERVISOR`.
Request body: `{ note: string }`.
Response 201: `{ event: AssistanceEvent }` (type `NOTE`).
Errores: `400`, `401`, `403`, `404`.

---

## 3. Sesión remota (broker) — eje central

### Abrir sesión remota — POST /sessions/{id}/remote-sessions
Propósito: abrir el canal intermediado para que el agente opere el equipo del cliente.
Auth: requerida — `AGENT` asignado. La sesión debe estar `ACTIVE` y con `consentAt` no nulo.

Request body (JSON):
```ts
interface OpenRemoteSessionBody {
  channel: RemoteSessionChannel;  // 'BROKER_TUNNEL' (router web admin) | 'COBROWSE'
  targetHost?: string;            // host del CPE en el LAN.
                                  // OBLIGATORIO para channel='BROKER_TUNNEL': debe ser la
                                  // IP del CPE en el LAN (p.ej. "192.168.1.1"). Si se omite
                                  // o está vacío con BROKER_TUNNEL, la respuesta es 400
                                  // VALIDATION_ERROR. Para COBROWSE es opcional.
  ttlSeconds?: number;            // 1..1800; default 600
}
```
Response 201:
```ts
interface OpenRemoteSessionResult {
  remoteSession: RemoteSession;   // status 'OPEN'
  connect: {
    wsUrl: string;                // wss endpoint del broker
    sessionToken: string;         // token de un solo uso, alcance a este CPE/sesión
    expiresAt: string;
  };
  // proxyCookieHeader NO se incluye en el JSON body — se emite como Set-Cookie HTTP.
}
```

**Cookie de proxy (Fase E):** además del body JSON, la respuesta incluye una cabecera `Set-Cookie` que el navegador almacena automáticamente:

```
Set-Cookie: wifix_proxy_session=<uuid-opaco>;
            HttpOnly;
            Secure (solo en producción);
            SameSite=Strict;
            Path=/asistencia/v1/broker/proxy/{remoteSessionId};
            Expires=<expiresAt en UTC>
```

- El valor es un UUID v4 opaco — el agente nunca recibe ni necesita el `sessionToken` del broker para navegar el panel del router.
- `Path` acotado al `remoteSessionId` de esta sesión: no contamina otras sesiones ni el resto del portal.
- La cookie se invalida server-side al cerrar la sesión (manual o por expiración de TTL).

Errores: `400` body inválido; `401`; `403` (no es el agente asignado); `404`; `409` (sesión no `ACTIVE`, sin consentimiento, o ya hay una sesión remota abierta).

> Seguridad: el token es de un solo uso, de vida corta, con alcance a un único CPE y sesión. El túnel se cierra automáticamente al expirar, al cerrar la sesión, o cuando la app del técnico pasa a segundo plano. La cookie de proxy se invalida en los tres mismos disparadores de auto-cierre.

### Proxy HTTP del panel del router — ALL /broker/proxy/{remoteSessionId}/*

Propósito: el agente navega el panel web del router del cliente desde el portal del Call Center (dentro de un `<iframe>`). El proxy convierte cada request HTTP del navegador en una trama `OPEN_STREAM` por el túnel del técnico, recibe la respuesta y la devuelve al navegador.

Auth: **cookie de sesión de proxy** `wifix_proxy_session` (httpOnly, emitida en `POST /sessions/{id}/remote-sessions`). **No se usa el JWT Bearer ni el sessionToken del broker.** El navegador envía la cookie automáticamente sin que el JS del portal la vea.

Métodos: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` (HEAD lo gestiona Fastify automáticamente junto con GET).

Path: el wildcard `/*` corresponde al path que el navegador solicita en el panel del router (p.ej. `/admin/login`, `/cgi-bin/save`). La query string se pasa tal cual al router.

Comportamiento:
1. Valida la cookie de proxy (server-side, no revela sessionToken al navegador).
2. Verifica que la cookie corresponde al `remoteSessionId` de la URL (403 si no).
3. Verifica que la `RemoteSession` está `OPEN` y no expirada (404/401 si no).
4. Verifica que hay un túnel activo del técnico (502 si no).
5. Re-aplica el SSRF guard sobre el `targetHost` almacenado (defensa en profundidad).
6. Valida el path (sin CRLF/NUL, longitud máx. 2048 chars).
7. Reenvía la request al router por el túnel del técnico (solo headers seguros; no reenvía la cookie de proxy ni el `Authorization` del portal).
8. Para respuestas `Content-Type: text/html`: inyecta `<base href="...">`, reescribe `href`/`src`/`action` absolutos y `url()` en CSS inline.
9. Strip de `X-Frame-Options` y `Content-Security-Policy` del router; añade `Content-Security-Policy: frame-ancestors <PORTAL_ORIGIN>` propia.
10. Reescribe las `Set-Cookie` del router: `Path` acotado al path del proxy, elimina `Domain`, eleva `SameSite` a `Strict`.
11. Audita cada request como `AssistanceEvent` tipo `REMOTE_SESSION` (fire-and-forget, sin datos sensibles).
12. Rate-limit: 120 req/min por IP (`PROXY_RATE_LIMIT_MAX`).
13. Timeout de 504 si el técnico no responde en 20s.

Errores:

| Código HTTP | `code` | Causa |
|---|---|---|
| `401` | `UNAUTHORIZED` | Cookie ausente, inválida o expirada |
| `403` | `FORBIDDEN` | Cookie no corresponde a esta remoteSession, o targetHost bloqueado |
| `404` | `NOT_FOUND` | RemoteSession no encontrada o no `OPEN` |
| `405` | `VALIDATION_ERROR` | Método HTTP no permitido |
| `413` | `VALIDATION_ERROR` | Body excede 4 MB |
| `502` | `TUNNEL_UNAVAILABLE` | Técnico sin túnel activo |
| `504` | `TIMEOUT` | El técnico no respondió en 20s |

Notas de seguridad:
- El `targetHost` es INMUTABLE desde la apertura de la RemoteSession. El agente no puede cambiarlo por URL ni por header.
- El navegador del agente nunca recibe el `sessionToken` del broker WSS.
- Las `Set-Cookie` del router quedan confinadas al path del proxy de esta sesión — no filtran al portal ni a otras sesiones.

Limitaciones de reescritura de HTML:
- Paneles que construyen URLs en JavaScript en runtime (p.ej. `fetch('/api/data')`, `window.location = '/dashboard'`) no se reescriben automáticamente. El tag `<base>` ayuda con la navegación declarativa; el JS dinámico requeriría un Service Worker (fuera de alcance).
- URLs absolutas del router codificadas en JS tampoco se reescriben.

### Cerrar sesión remota — POST /remote-sessions/{id}/close
Propósito: cerrar el canal intermediado.
Auth: requerida — `AGENT` asignado o `SUPERVISOR`.
Response 200: `{ remoteSession: RemoteSession }` (status `CLOSED`).
Errores: `401`, `403`, `404`.

---

## 4. Acciones de equipo (ACS / TR-069) — plano complementario

### Solicitar acción — POST /sessions/{id}/actions
Propósito: ejecutar una acción estandarizada sobre el equipo vía ACS (cuando el equipo lo soporta).
Auth: requerida — `AGENT` asignado. Sesión `ACTIVE`.

Request body (JSON):
```ts
interface RequestActionBody {
  action: RemoteActionType;
  params?:
    | { ssid?: string; password?: string; band?: '2.4GHz' | '5GHz' }   // SET_WIFI
    | { band: '2.4GHz' | '5GHz'; channel: number }                      // SET_CHANNEL
    | { target: string; kind: 'ping' | 'traceroute' }                   // RUN_DIAGNOSTIC
    | Record<string, never>;                                            // REBOOT / FACTORY_RESET / REPROVISION
}
```
Response 202:
```ts
{ action: RemoteAction }          // status 'PENDING'; el resultado llega por WS (ACTION_RESULT)
```
Errores **síncronos** (en la respuesta HTTP): `400`; `401`; `403`; `404`; `409` (sesión no `ACTIVE`).

> **Fallo del conector (asíncrono):** como la ejecución es asíncrona (el endpoint
> responde `202` y el resultado llega por WS), un fallo del ACS —no responde, o el
> equipo no soporta la acción— **no** produce un `502` HTTP. Se reporta como la acción
> en estado `FAILED` con `result.code = 'CONNECTOR_ERROR'` y `result.message` en español,
> emitida por el evento `ACTION_RESULT` del WebSocket. El `502 CONNECTOR_ERROR` solo
> aplica a endpoints que llaman al conector de forma **síncrona** (p.ej. `POST /sessions/{id}/tickets`).

### Listar acciones — GET /sessions/{id}/actions
Auth: participantes o `SUPERVISOR`.
Response 200: `Paginated<RemoteAction>`.
Errores: `401`, `403`, `404`.

---

## 5. Video (Jitsi self-host)

### Provisionar sala — POST /sessions/{id}/video
Propósito: crear/obtener la sala Jitsi de la sesión y un JWT de sala.
Auth: requerida — participantes (técnico de la sesión / agente asignado).
Response 201:
```ts
interface VideoRoom {
  roomName: string;
  domain: string;                 // dominio del Jitsi self-host
  jwt: string;                    // JWT de sala, vigencia corta
}
```
Errores: `401`, `403`, `404`.

---

## 6. Estudio WiFi y operadora (reutilización)

El módulo **no reimplementa** el diagnóstico: lo consume de `/herramientas/v1`.

### Estudio agregado — GET /sessions/{id}/study
Propósito: vista consolidada del último estudio de la cuenta para el agente.
Auth: participantes o `SUPERVISOR`.
Response 200:
```ts
interface StudyOverview {
  accountNumber: string;
  latestHeatmapId: string | null;
  latestSpeedtest: { downloadMbps: number; uploadMbps: number; measuredAt: string } | null;
  pings: Array<{ target: string; avgLatencyMs: number | null; packetLossPercent: number | null }>;
  lanDeviceCount: number | null;
  wifiDeviceCount: number | null;
  plant: { onuRxPower?: number; snr?: number; source: string } | null;  // vía conector ispmonitor
}
```
Errores: `401`, `403`, `404`.

### Generar ticket / orden operadora — POST /sessions/{id}/tickets
Propósito: para casos no resueltos, generar ticket / orden FSM en la operadora (conectores plegados de Proxy Xtrim).
Auth: `AGENT` asignado o `SUPERVISOR`.
Request body:
```ts
interface CreateOperatorTicketBody {
  kind: 'TICKET' | 'FSM_ORDER';
  description: string;
  scheduleTurno?: boolean;        // agenda visita técnica si aplica
}
```
Response 201:
```ts
{ externalId: string; kind: 'TICKET' | 'FSM_ORDER'; status: string }
```
Errores: `400`, `401`, `403`, `404`, `502` (operadora no responde).

---

## 7. Auto-asistencia (Fase F)

El motor de auto-asistencia corre el estudio + telemetría de planta, detecta causas con reglas puras y propone remediaciones. Las remediaciones se aplican vía el conector ACS (igual que en §4). La aplicación es **síncrona** (→ 502 si el conector falla) y **auditada** (AssistanceEvent + ConnectorCallLog). Es **reversible**: el estado previo se persiste en el request de la RemoteAction antes de aplicar.

### Detectar causas — GET /sessions/{id}/auto-assist

Propósito: analizar métricas de la cuenta y devolver causas detectadas + remediaciones propuestas. **No aplica ninguna acción**.
Auth: participantes o `SUPERVISOR`.

Response 200:
```ts
type CauseCode =
  | 'WIFI_SIGNAL_LOW'
  | 'SNR_DEGRADED'
  | 'CHANNEL_SATURATED'
  | 'ONU_RX_POWER_OUT_OF_RANGE'
  | 'CABLEMODEM_DOWNSTREAM_LOW'
  | 'CABLEMODEM_MER_LOW';

type RemediationAction = 'SET_CHANNEL' | 'REPROVISION' | 'REBOOT' | 'FACTORY_RESET';

interface DetectedCause {
  code: CauseCode;
  description: string;
  measuredValue: number;
  threshold: number;
}

interface ProposedRemediation {
  id: string;                        // ID determinista (ej. "remediation:SET_CHANNEL:WIFI_SIGNAL_LOW")
  cause: CauseCode;
  action: RemediationAction;
  description: string;
  params: Record<string, unknown>;   // parámetros listos para aplicar (ej. { band, channel })
  previousState: null;               // siempre null en propuesta; se rellena al aplicar
  reversible: boolean;
}

interface AutoAssistAnalysis {
  accountNumber: string;
  sessionId: string;
  causes: DetectedCause[];
  proposals: ProposedRemediation[];
  analysedAt: string;               // ISO 8601
}
```
Errores: `401`, `403`, `404`.

### Aplicar remediación — POST /sessions/{id}/auto-assist/apply

Propósito: aplica una remediación propuesta por `GET /auto-assist`. Requiere consentimiento.
Auth: `AGENT` asignado. Sesión `ACTIVE`.

Request body:
```ts
interface ApplyRemediationBody {
  remediationId: string;             // ID de la propuesta devuelta por GET /auto-assist
}
```
Response 200:
```ts
interface ApplyRemediationResult {
  remediationId: string;
  action: RemediationAction;
  status: 'APPLIED' | 'FAILED';
  message: string;
  previousState: Record<string, unknown> | null;  // para revertir manualmente si hace falta
}
```
Errores:
- `400` `remediationId` ausente.
- `401` no autenticado.
- `403` no es el agente asignado.
- `404` sesión no encontrada.
- `409` sesión no `ACTIVE` o sin `consentAt` (mensaje en español explícito).
- `502` el conector ACS no respondió o rechazó la acción.

El resultado también se emite por WebSocket como evento `ACTION_RESULT` (reutiliza el canal de §4).

> **Reversión manual:** si el operador desea revertir una remediación, usa `POST /sessions/{id}/actions` con la acción correspondiente y los parámetros del campo `previousState` del resultado.

---

## 8. WebSocket de señalización — `/asistencia/v1/ws`

Conexión autenticada con el JWT (header `Authorization` o query `?token=`). Un mensaje = un objeto JSON `{ type, ... }`.

**Cliente → servidor:**
```ts
type ClientMessage =
  | { type: 'REGISTER_TECHNICIAN'; sessionId: string }   // técnico se une a su sesión
  | { type: 'SUBSCRIBE_QUEUE' }                           // agente observa la cola
  | { type: 'JOIN_SESSION'; sessionId: string }           // agente entra a una sesión
  | { type: 'CHAT_MESSAGE'; sessionId: string; text: string }
  | { type: 'HEARTBEAT' };
```

**Servidor → cliente:**
```ts
type ServerEvent =
  | { type: 'QUEUE_UPDATED'; session: AssistanceSession }              // alta/cambio en la cola
  | { type: 'SESSION_STATE_CHANGED'; session: AssistanceSession }
  | { type: 'ACTION_RESULT'; action: RemoteAction }                   // resultado de acción ACS
  | { type: 'REMOTE_SESSION_READY'; remoteSession: RemoteSession;
      connect?: { wsUrl: string; sessionToken: string; expiresAt: string } }
  | { type: 'CHAT_MESSAGE'; sessionId: string; from: string; text: string; at: string }
  | { type: 'PEER_PRESENCE'; sessionId: string; role: Role; online: boolean }
  | { type: 'ERROR'; code: string; message: string };
```

Reglas:
- El servidor valida el rol y la pertenencia a la sesión antes de unir a un cliente a una sala.
- `REGISTER_TECHNICIAN` por parte del técnico es lo que habilita, del lado del LAN, el túnel de la sesión remota (ver ADR-0002).
- Sin `HEARTBEAT` dentro del intervalo configurado, el servidor cierra la conexión y marca presencia offline.

---

## 9. Notas para implementación (Fases B–F)

- **Fase B:** sesiones + WS + máquina de estados, con ACS y broker en mock.
- **Fase C:** acciones ACS reales (extiende el conector `acs` existente con `reboot`, `setChannel`, `factoryReset`, `reprovision`, `runDiagnostic`).
- **Fase D:** broker WSS real (protocolo de trama del túnel) + grabación opcional a `MediaFile`.
- **Fase E:** portal React+TS+Vite consumiendo este contrato.
- **Fase F:** conectores de operadora (ticketing/scheduling) + auto-asistencia.
