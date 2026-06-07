# Portal del Call Center — Arquitectura y Plan de Implementación (Fase E)

Documento de diseño previo a la implementación. Audiencia: especialista `frontend`.  
Fuentes de verdad: `docs/api/asistencia-tecnica.md`, `docs/adr/asistencia-tecnica.md`,
`docs/asistencia-broker-protocolo.md`.  
Stack congelado por ADR-0003: **React + TypeScript + Vite**. No cambiar sin ADR nuevo.

---

## 1. Ubicación en el monorepo

```
C:\Wifix App\                          (raíz del monorepo)
├── backend/                           (Fastify — ya construido)
├── wifix-webapp/                      (app del técnico — Capacitor vanilla)
├── portal-callcenter/                 ← NUEVO (Fase E)
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── .eslintrc.cjs
│   ├── .prettierrc
│   ├── .env.example
│   ├── public/
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── types/                     (tipos compartidos con el contrato)
│       │   ├── assistance.ts          (re-exporta los tipos del contrato API)
│       │   └── auth.ts
│       ├── lib/
│       │   ├── api/
│       │   │   ├── client.ts          (REST client: fetch wrapper + interceptor JWT)
│       │   │   ├── assistance.ts      (todas las llamadas a /asistencia/v1)
│       │   │   └── auth.ts            (login)
│       │   ├── ws/
│       │   │   ├── AssistanceSocket.ts  (singleton WS con reconexión)
│       │   │   └── types.ts           (ClientMessage / ServerEvent del contrato)
│       │   └── jitsi/
│       │       └── JitsiFrame.tsx     (wrapper del iframe Jitsi External API)
│       ├── stores/
│       │   ├── auth.store.ts          (Zustand: token, user, rol)
│       │   └── session.store.ts       (Zustand: sesión activa, remoteSession, chat)
│       ├── hooks/
│       │   ├── useQueue.ts            (React Query + WS QUEUE_UPDATED)
│       │   ├── useSession.ts          (React Query + WS SESSION_STATE_CHANGED)
│       │   ├── useEvents.ts           (timeline paginado)
│       │   ├── useActions.ts          (lista + mutación POST actions)
│       │   └── useBrokerProxy.ts      (cliente WS broker — ver §6)
│       ├── pages/
│       │   ├── LoginPage.tsx
│       │   ├── QueuePage.tsx
│       │   ├── SessionDetailPage.tsx  (layout con tabs)
│       │   │   tabs:
│       │   │   ├── StudyTab.tsx       (GET /sessions/{id}/study — solo consume)
│       │   │   ├── ConsoleTab.tsx     (video + ACS + sesión remota)
│       │   │   └── TimelineTab.tsx    (GET /sessions/{id}/events)
│       │   └── NotFoundPage.tsx
│       ├── components/
│       │   ├── queue/
│       │   │   ├── QueueTable.tsx
│       │   │   └── QueueRow.tsx
│       │   ├── session/
│       │   │   ├── SessionHeader.tsx  (estado, transiciones, notas)
│       │   │   ├── StatusBadge.tsx
│       │   │   └── NoteForm.tsx
│       │   ├── study/
│       │   │   └── StudyPanel.tsx     (render de StudyOverview)
│       │   ├── console/
│       │   │   ├── VideoPanel.tsx     (monta JitsiFrame)
│       │   │   ├── AcsActionsPanel.tsx
│       │   │   └── RemotePanel.tsx    (sesión remota — ver §6)
│       │   ├── timeline/
│       │   │   └── EventTimeline.tsx
│       │   └── ui/                    (botones, badges, spinners reutilizables)
│       └── router/
│           └── index.tsx              (React Router v6)
├── docs/
│   ├── api/asistencia-tecnica.md
│   ├── adr/asistencia-tecnica.md
│   ├── asistencia-broker-protocolo.md
│   └── portal-callcenter-arquitectura.md   ← este archivo
```

**Convención de nombres:** kebab-case para carpetas, PascalCase para componentes, camelCase
para hooks y utilidades — igual que la convención del repo.

---

## 2. Stack y dependencias de producción elegidas

| Paquete | Versión mínima | Justificación |
|---|---|---|
| `react` + `react-dom` | 18.x | base |
| `typescript` | 5.x | strict mode |
| `vite` | 5.x | ADR-0003; build rápido |
| `react-router-dom` | 6.x | SPA routing ligero, no Next.js |
| `@tanstack/react-query` | 5.x | server-state: cache, invalidación, loading/error |
| `zustand` | 4.x | estado de cliente ligero (auth token, sesión activa WS) |
| `clsx` | 2.x | utilidad de classnames condicionales |

**Dependencias de desarrollo:**

| Paquete | Uso |
|---|---|
| `@vitejs/plugin-react` | plugin base |
| `eslint` + `@typescript-eslint/*` | lint |
| `prettier` | formato (alineado con el repo: 2 espacios, trailing comma, single quote) |
| `vitest` + `@testing-library/react` | tests unitarios/integración de componentes |

**No se agrega:** Axios (fetch nativo es suficiente), Redux (Zustand es más liviano),
Material UI / Chakra (Tailwind es el stack del monorepo, pero el portal-callcenter puede
usar su propio preset mínimo o clases Tailwind directas — a decidir con Franco; por
defecto: Tailwind CSS con el mismo `tailwind.config` del repo si está disponible, o un
preset propio acotado).

> Nota para `frontend`: instalar con `npm create vite@latest portal-callcenter -- --template react-ts`
> desde la raíz del monorepo. No instalar nada hasta que el scaffold esté aprobado.

---

## 3. Variables de entorno del portal

Archivo: `portal-callcenter/.env.example`

```env
# URL base del backend Fastify (sin trailing slash)
VITE_API_BASE_URL=http://localhost:8080

# URL base del WebSocket de señalización
# Derivado de VITE_API_BASE_URL reemplazando http→ws / https→wss
# Se puede sobreescribir explícitamente:
VITE_WS_BASE_URL=ws://localhost:8080

# Dominio del Jitsi self-host (igual que backend env JITSI_DOMAIN)
VITE_JITSI_DOMAIN=meet.wifix.internal
```

El cliente REST deriva automáticamente `wsUrl` de `VITE_WS_BASE_URL` más la ruta
`/asistencia/v1/ws`. El `wsUrl` del broker se recibe ya completo del backend en la
respuesta de `POST /sessions/{id}/remote-sessions` y no depende de ninguna variable del
portal.

---

## 4. Routing (React Router v6)

```
/login                          → LoginPage          (pública)
/                               → redirect → /queue  (protegida)
/queue                          → QueuePage           (AGENT | SUPERVISOR)
/sessions/:id                   → SessionDetailPage   (AGENT | SUPERVISOR)
/sessions/:id?tab=study         → tab Study (por defecto)
/sessions/:id?tab=console       → tab Console
/sessions/:id?tab=timeline      → tab Timeline
*                               → NotFoundPage
```

Guard de ruta: `<RequireAuth roles={['AGENT','SUPERVISOR']}>` envuelve todas las rutas
protegidas. Lee el token y el rol del store Zustand; si no hay token, redirige a `/login`.

`SessionDetailPage` recibe el `id` por `useParams()` y maneja sus propias tabs por query
param (no se necesitan subrutas anidadas para la complejidad actual).

---

## 5. Modelo de datos de UI (tipos TypeScript)

Los tipos se definen en `portal-callcenter/src/types/assistance.ts` copiando
**literalmente** las interfaces del contrato (`docs/api/asistencia-tecnica.md §1`).
Ningún tipo se inventa; si el contrato cambia, el archivo de tipos se actualiza.

```typescript
// src/types/assistance.ts — FUENTE: docs/api/asistencia-tecnica.md §1
export type Role = 'TECHNICIAN' | 'AGENT' | 'SUPERVISOR';

export type AssistanceStatus =
  | 'REQUESTED' | 'QUEUED' | 'ASSIGNED' | 'ACTIVE' | 'ON_HOLD'
  | 'RESOLVED' | 'UNRESOLVED' | 'CANCELLED' | 'EXPIRED';

export type RemoteActionType =
  | 'REBOOT' | 'SET_WIFI' | 'SET_CHANNEL' | 'FACTORY_RESET'
  | 'REPROVISION' | 'RUN_DIAGNOSTIC';

export type RemoteActionStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
export type RemoteSessionChannel = 'BROKER_TUNNEL' | 'COBROWSE';
export type RemoteSessionStatus  = 'OPEN' | 'CLOSED' | 'EXPIRED';
export type AssistanceEventType  =
  | 'STATE_CHANGE' | 'NOTE' | 'ACTION' | 'REMOTE_SESSION' | 'CHAT' | 'CONSENT';

export interface AssistanceSession { /* igual que el contrato */ }
export interface AssistanceEvent   { /* igual que el contrato */ }
export interface RemoteAction      { /* igual que el contrato */ }
export interface RemoteSession     { /* igual que el contrato */ }
export interface Paginated<T>      { items: T[]; page: number; pageSize: number; total: number; }
export interface StudyOverview     { /* igual que el contrato §6 */ }

// Tipos de mensajes WS (contrato §7)
export type ClientMessage = /* ... */;
export type ServerEvent   = /* ... */;
```

`src/types/auth.ts`:

```typescript
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'AGENT' | 'SUPERVISOR';
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
```

---

## 6. Cliente REST

**Archivo:** `src/lib/api/client.ts`

Wrapper sobre `fetch` nativo. Responsabilidades:
- Prefijar todas las rutas con `VITE_API_BASE_URL`.
- Inyectar `Authorization: Bearer <token>` desde el store Zustand.
- Deserializar JSON.
- Mapear errores HTTP a objetos `ApiError` tipados con `code` y `message` (del contrato).
- Lanzar si `response.ok === false`.

```typescript
// Firma pública:
async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T>
async function apiPost<T>(path: string, body?: unknown): Promise<T>

// Manejo de errores:
export class ApiError extends Error {
  constructor(
    public readonly code: string,    // ej. 'CONFLICT', 'NOT_FOUND'
    public readonly status: number,
    message: string,
  ) { super(message); }
}
```

**Archivo:** `src/lib/api/assistance.ts` — todas las llamadas al módulo:

```typescript
// Sesiones
export const getQueue     = (params) => apiGet<Paginated<AssistanceSession>>('/asistencia/v1/sessions', params)
export const getSession   = (id)     => apiGet<SessionDetail>(`/asistencia/v1/sessions/${id}`)
export const assignSession= (id)     => apiPost(`/asistencia/v1/sessions/${id}/assign`)
export const changeStatus = (id, body) => apiPost(`/asistencia/v1/sessions/${id}/status`, body)
export const addNote      = (id, note) => apiPost(`/asistencia/v1/sessions/${id}/notes`, { note })
export const getEvents    = (id, params) => apiGet<Paginated<AssistanceEvent>>(`/asistencia/v1/sessions/${id}/events`, params)

// Estudio (solo GET, sin reimplementar diagnóstico)
export const getStudy     = (id) => apiGet<StudyOverview>(`/asistencia/v1/sessions/${id}/study`)

// Acciones ACS
export const requestAction   = (id, body) => apiPost<{action: RemoteAction}>(`/asistencia/v1/sessions/${id}/actions`, body)
export const getActions      = (id, params) => apiGet<Paginated<RemoteAction>>(`/asistencia/v1/sessions/${id}/actions`, params)

// Video
export const provisionVideo  = (id) => apiPost<VideoRoom>(`/asistencia/v1/sessions/${id}/video`)

// Sesión remota
export const openRemoteSession  = (id, body) => apiPost<OpenRemoteSessionResult>(`/asistencia/v1/sessions/${id}/remote-sessions`, body)
export const closeRemoteSession = (rsId)     => apiPost<{remoteSession: RemoteSession}>(`/asistencia/v1/remote-sessions/${rsId}/close`)

// Ticket operadora
export const createTicket = (id, body) => apiPost(`/asistencia/v1/sessions/${id}/tickets`, body)
```

`SessionDetail` es el tipo de la respuesta de `GET /sessions/{id}`:

```typescript
interface SessionDetail {
  session: AssistanceSession;
  activeRemoteSession: RemoteSession | null;
  videoRoom: { roomName: string; domain: string } | null;
  recentActions: RemoteAction[];
}
```

---

## 7. Cliente WebSocket de señalización

### 7.1 Decisión: conexión única (singleton) vs por-vista

**Decisión: singleton por sesión de usuario.** Una sola instancia de WebSocket se abre
al hacer login y se mantiene viva mientras el agente esté autenticado. Las vistas se
suscriben a eventos a través de un EventEmitter interno; no abren sus propias conexiones.

Justificación: el protocolo del servidor usa `SUBSCRIBE_QUEUE` y `JOIN_SESSION` como
mensajes de registro, no como URLs distintas. Múltiples WS simultáneos del mismo usuario
generarían duplicados de eventos y presencia incorrecta. El singleton simplifica la
reconexión y el heartbeat.

### 7.2 Implementación — `AssistanceSocket.ts`

```typescript
// src/lib/ws/AssistanceSocket.ts (pseudo-código de diseño)

class AssistanceSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  connect(token: string): void
  disconnect(): void

  // Mensajes cliente → servidor
  subscribeQueue(): void            // emite SUBSCRIBE_QUEUE
  joinSession(sessionId: string): void  // emite JOIN_SESSION
  sendHeartbeat(): void             // emite HEARTBEAT
  sendChat(sessionId: string, text: string): void

  // Internos
  private handleMessage(raw: string): void  // parsea y emite por tipo
  private scheduleReconnect(): void         // exponential backoff: 1s, 2s, 4s, 8s, max 30s
  private startHeartbeat(): void            // cada 45s (< 60s del servidor)
  private stopHeartbeat(): void
}

export const assistanceSocket = new AssistanceSocket();
```

Detalles de la reconexión:
- Backoff exponencial: `Math.min(1000 * 2^n, 30_000)` ms, donde `n` = intentos consecutivos.
- Al reconectar, re-emitir las suscripciones activas (`SUBSCRIBE_QUEUE` si estaba en cola,
  `JOIN_SESSION` si estaba en una sesión).
- Al recibir `close` con código 1008 (Policy Violation = JWT inválido), no reconectar;
  disparar logout.
- El token se lee del store Zustand al conectar; si expira, el servidor cerrará la conexión
  con 1008 y el portal mostrará la pantalla de login.

### 7.3 Integración con React Query

Los hooks de datos combinan React Query (cache REST) + eventos WS:

```typescript
// useQueue.ts
export function useQueue(params) {
  const query = useQuery({
    queryKey: ['queue', params],
    queryFn: () => getQueue(params),
    refetchInterval: 30_000,   // fallback polling si WS falla
  });

  useEffect(() => {
    const handler = (event: ServerEvent) => {
      if (event.type === 'QUEUE_UPDATED') {
        queryClient.setQueryData(['queue', params], (old) => mergeSessionIntoQueue(old, event.session));
      }
    };
    assistanceSocket.on('message', handler);
    assistanceSocket.subscribeQueue();
    return () => assistanceSocket.off('message', handler);
  }, [params]);

  return query;
}

// useSession.ts
export function useSession(sessionId: string) {
  const query = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => getSession(sessionId),
  });

  useEffect(() => {
    assistanceSocket.joinSession(sessionId);
    const handler = (event: ServerEvent) => {
      if (event.type === 'SESSION_STATE_CHANGED' && event.session.id === sessionId) {
        queryClient.setQueryData(['session', sessionId], (old) => ({ ...old, session: event.session }));
      }
      if (event.type === 'ACTION_RESULT' && event.action.sessionId === sessionId) {
        queryClient.invalidateQueries({ queryKey: ['actions', sessionId] });
        // también actualizar session.store para notificación en UI
      }
      if (event.type === 'REMOTE_SESSION_READY') {
        // actualizar session.store con la remoteSession + connect info
      }
    };
    assistanceSocket.on('message', handler);
    return () => assistanceSocket.off('message', handler);
  }, [sessionId]);

  return query;
}
```

### 7.4 Store Zustand para estado WS-driven

```typescript
// stores/session.store.ts
interface SessionStore {
  activeSessionId: string | null;
  remoteSession: RemoteSession | null;
  brokerConnect: { wsUrl: string; sessionToken: string; expiresAt: string } | null;
  pendingActions: RemoteAction[];       // acciones en PENDING esperando ACTION_RESULT
  chatMessages: ChatMessage[];
  peerPresence: Record<string, { role: Role; online: boolean }>;

  setRemoteSession(rs: RemoteSession, connect?: BrokerConnect): void;
  clearRemoteSession(): void;
  addPendingAction(action: RemoteAction): void;
  resolveAction(action: RemoteAction): void;   // llega por ACTION_RESULT
}
```

---

## 8. Integración Jitsi

**Archivo:** `src/lib/jitsi/JitsiFrame.tsx`

Jitsi se integra vía **iframe + Jitsi External API** (`external_api.js` cargado
dinámicamente desde el dominio Jitsi self-host). Este es el modo soportado y estable
para embeber Jitsi en cualquier SPA sin depender de un paquete npm del ecosistema Jitsi
(que no tiene releases estables para React 18).

Flujo de montaje:

1. El agente pulsa "Iniciar video" en `VideoPanel`.
2. El portal llama `POST /sessions/{id}/video` → recibe `{ roomName, domain, jwt }`.
3. `JitsiFrame` se monta con esas props.
4. Al montar, el componente carga `https://<domain>/external_api.js` mediante un script
   tag dinámico (si no está ya cargado) y luego instancia `window.JitsiMeetExternalAPI`.
5. Al desmontar (cambio de sesión, cierre), invoca `api.dispose()`.

```typescript
interface JitsiFrameProps {
  roomName: string;
  domain: string;
  jwt: string;
  displayName: string;
  onHangup?: () => void;
}

export function JitsiFrame({ roomName, domain, jwt, displayName, onHangup }: JitsiFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<unknown>(null);

  useEffect(() => {
    // cargar external_api.js si no está
    // instanciar JitsiMeetExternalAPI
    // registrar listener 'videoConferenceLeft' → onHangup?.()
    return () => { (apiRef.current as any)?.dispose(); };
  }, [roomName, domain, jwt]);

  return <div ref={containerRef} className="jitsi-container" aria-label="Videollamada" />;
}
```

Consideraciones:
- El JWT de sala tiene vida corta (configurable en backend, default 30 min). Si la sesión
  dura más, el agente tendrá que volver a llamar `POST /sessions/{id}/video` y remontar
  el iframe. El portal debe manejar esta renovación (un botón "Reconectar video" al
  recibir evento de sala expirada desde Jitsi External API).
- El servidor Jitsi self-host en Hetzner debe estar en HTTPS. El iframe de un portal
  HTTPS no puede cargar contenido HTTP (mixed content). Esto es una restricción de
  infraestructura, no del portal.

---

## 9. El punto duro: panel de sesión remota del lado del agente

Esta es la decisión de mayor impacto de Fase E. Se analizan tres opciones.

### Opción A: iframe apuntando a un endpoint HTTP del broker (reverse proxy HTTP)

El backend expone un endpoint HTTP (p. ej. `GET /asistencia/v1/broker/proxy/{remoteSessionId}/*`)
que actúa de reverse proxy: recibe el request HTTP del navegador del agente, lo convierte
en una trama `OPEN_STREAM` al broker, recibe la respuesta y la devuelve como response HTTP.
El portal embebe esto en un `<iframe src="...">`.

**Ventajas:** el agente ve el panel real del router con assets, JS, formularios — todo el
HTML original sin transformar.  
**Desventajas:**
- Requiere un endpoint HTTP nuevo en el backend (no es puramente cliente).
- Complejo: el reverse proxy HTTP debe reescribir URLs relativas en el HTML del router
  (p. ej. `href="/js/app.js"` debe resolverse contra la base del proxy, no del portal).
  Paneles de routers de distintos fabricantes varían mucho en esto.
- El broker actual habla WS multiplexado, no HTTP directo. Añadir un proxy HTTP sobre él
  es trabajo de backend no trivial.
- Seguridad: el token de un solo uso ya fue consumido al abrir el WS del broker. Hay que
  emitir un token de sesión HTTP separado (o un cookie de sesión) para el proxy, con
  el mismo alcance acotado. Más superficie.
- Los paneles de routers típicamente usan cookies de autenticación propias. El rewrite de
  cookies entre el portal y el proxy es complejo y los paneles pueden rechazarlo.

**Costo backend:** endpoint nuevo `GET /broker/proxy/{id}/*` que actúa de HTTP↔WS bridge.
Estimación: alta complejidad, 2–3 días de backend + QA de reescritura de URLs.

### Opción B: cliente WS broker en el portal que reconstruye la UI

El portal abre directamente la conexión WS al endpoint del broker
(`wss://.../asistencia/v1/broker/connect?sessionToken=<jwt>`), habla el protocolo de
trama (`OPEN_STREAM` / `DATA` / `END_STREAM` / `RESPONSE`) y con las respuestas
reconstruye un `<iframe srcdoc="...">` o renderiza el HTML del router en el DOM.

**Ventajas:** puramente cliente; no toca backend.  
**Desventajas:**
- Los paneles de routers incluyen assets (CSS, JS, imágenes) referenciados con URLs
  relativas o absolutas. El cliente tendría que interceptar cada `fetch` del iframe,
  convertirlo en un nuevo stream al broker y devolver el asset. Esto requiere un Service
  Worker (para interceptar los fetches del iframe) o `<iframe sandbox>` con un DOM
  virtual — ambos extremadamente complejos de implementar de forma robusta.
- Las URLs del panel del router incluyen autenticación propia (cookies, formularios POST).
  Manejar eso desde el exterior es casi imposible sin transformar el HTML.
- Inviable para un portal de producción sin meses de ingeniería.

**Costo:** muy alto, impracticable en Fase E.

### Opción C (RECOMENDADA): MVP acotado para Fase E — consola funcional sin render completo del panel

El panel de sesión remota en Fase E **no renderiza el HTML del router** directamente.
En cambio, ofrece:

1. **Indicador de sesión remota activa:** muestra que el túnel está abierto, el `targetHost`
   del CPE, el tiempo restante hasta expiración (countdown del `expiresAt`), y botón de
   cierre.
2. **Acciones ACS** (ya cubiertas en `AcsActionsPanel`): reboot, set WiFi, set canal,
   factory reset, reprovision, run diagnostic — estas son las acciones operativas reales
   que el agente necesita para resolver el 90 % de los casos según ADR-0001.
3. **Apertura/cierre controlado de la sesión remota:** formulario para introducir el
   `targetHost` (IP del CPE), `ttlSeconds`, y canal (`BROKER_TUNNEL`); llamada a
   `POST /sessions/{id}/remote-sessions`; manejo del evento WS `REMOTE_SESSION_READY`.
4. **Estado del broker en tiempo real:** el evento WS `REMOTE_SESSION_READY` + presencia
   del técnico (`PEER_PRESENCE`) confirman que el túnel está activo; si el técnico se
   desconecta, el portal lo muestra.
5. **Nota de alcance (UX):** un banner en la UI explica al agente que la operación directa
   del panel del router estará disponible en una sub-fase posterior (Fase E.2).

La **consola queda 100 % funcional** en todos los demás aspectos: video Jitsi, todas las
acciones ACS, apertura/cierre de sesión remota, auditoría en tiempo real. Lo que no está
en Fase E es el render del HTML del panel del router dentro del navegador del agente.

**Ventajas:** cero trabajo de backend adicional; entrega la consola operativa en el plazo
de Fase E; cubre el flujo real de trabajo del agente (ACS + video + sesión remota
controlada); deja abierta la puerta a la Opción A en Fase E.2 cuando el broker HTTP proxy
se especifique e implemente correctamente.  
**Desventaja:** el agente no puede "navegar" el panel del router. Según ADR-0001, las
acciones ACS cubren el caso de uso central; la navegación directa del panel es un "nice
to have" de alto costo.

### Decisión: Opción C para Fase E

Para Fase E se implementa la Opción C. Si Franco y el cliente (Xtrim) confirman que la
navegación directa del panel del router es un requerimiento bloqueante, se planifica Fase
E.2 con la Opción A, que requiere un contrato de backend nuevo (ver §9.1).

### 9.1 Contrato backend para Opción A (si se aprueba en Fase E.2)

Si se decide implementar Opción A, el backend necesita:

```
GET /asistencia/v1/broker/proxy/{remoteSessionId}/{path*}

Auth: cookie de sesión HTTP emitida al abrir la sesión remota (separada del sessionToken WS).
Rol: AGENT asignado.

Comportamiento:
  1. Validar cookie de sesión → obtener remoteSessionId y targetHost del token.
  2. Verificar que la RemoteSession está OPEN y no expirada.
  3. Abrir un stream al broker vía el canal WS del técnico activo.
  4. Reescribir URLs relativas en respuestas Content-Type: text/html.
  5. Devolver la respuesta HTTP del router como response HTTP al navegador.

Respuestas de error:
  401 — sesión no válida o cookie expirada.
  404 — RemoteSession no encontrada o CLOSED/EXPIRED.
  502 — túnel no activo (técnico desconectado).
  504 — timeout del stream (> 20s sin RESPONSE del técnico).
```

Esta especificación es la que coordinaría Franco con el especialista backend.

---

## 10. Manejo de errores y permisos en UI

### Mapeo de códigos de error a UX

| Código HTTP | code API | UX |
|---|---|---|
| 401 UNAUTHORIZED | `UNAUTHORIZED` | Redirigir a `/login`; limpiar store |
| 403 FORBIDDEN | `FORBIDDEN` | Toast "No tienes permiso para esta acción" |
| 404 NOT_FOUND | `NOT_FOUND` | Mensaje inline "Sesión no encontrada"; no redirigir automáticamente |
| 409 CONFLICT | `CONFLICT` | Toast específico (p. ej. "La sesión ya fue tomada por otro agente") |
| 400 VALIDATION_ERROR | `VALIDATION_ERROR` | Errores en formulario / toast con `message` del backend |
| 429 (rate limit) | — | Toast "Demasiadas solicitudes, espera un momento" + deshabilitar botón temporalmente |
| 502 CONNECTOR_ERROR | `CONNECTOR_ERROR` | Toast "Error del sistema externo: <message>" |
| 500 INTERNAL_ERROR | `INTERNAL_ERROR` | Toast genérico "Error inesperado"; loggear en consola |

Errores asíncronos ACS (llegan por WS `ACTION_RESULT` con `status='FAILED'`):
- Mostrar en el panel de acciones con icono de error y el `result.message` del backend.
- No son toasts; se persisten visualmente hasta que el agente descarte.

Errores WS (evento `ERROR`):
- Mostrar banner no bloqueante en la consola: "Error en tiempo real: <message>".

### Gating por rol

El store Zustand expone `authUser.role`. Un hook `useRequireRole(roles)` verifica y
redirige si el rol no está en la lista. Las vistas `/queue` y `/sessions/:id` requieren
`['AGENT','SUPERVISOR']`. El `SUPERVISOR` tiene acceso de solo lectura a cualquier sesión
(puede ver detalles y timeline de sesiones de otros agentes) pero no puede tomar/asignar
(eso es solo `AGENT`). Los botones de acción se deshabilitan por rol en el componente,
además del guard de ruta.

---

## 11. Confirmación: nada de diagnóstico WiFi se reimplementa

El portal **no implementa** speedtest, ping, traceroute, mapa de calor ni escaneo de
dispositivos. `StudyTab` llama únicamente a `GET /asistencia/v1/sessions/{id}/study` y
renderiza el `StudyOverview` devuelto. El `latestHeatmapId` puede usarse para construir
una URL de imagen si el backend expone el heatmap como imagen (p. ej.
`GET /herramientas/v1/heatmap/{id}/image`), pero la generación del heatmap sigue siendo
exclusividad de `/herramientas/v1`. El visor de estudio en el portal es **solo lectura y
solo consumo**.

---

## 12. Plan por etapas para `frontend`

Cada etapa tiene su Definition of Done (DoD). El orden es estricto: cada etapa depende de
la anterior.

---

### Etapa 1 — Scaffold + configuración + login

**Tareas:**
1. Crear `portal-callcenter/` con `npm create vite@latest portal-callcenter -- --template react-ts`.
2. Instalar dependencias: `react-router-dom`, `@tanstack/react-query`, `zustand`, `clsx`.
3. Configurar `vite.config.ts`: proxy de dev hacia `http://localhost:8080` para evitar
   CORS en desarrollo (solo dev; en producción el backend configura `CORS_ORIGIN`).
4. Configurar TypeScript en modo strict (`tsconfig.json`: `"strict": true,
   "noUncheckedIndexedAccess": true`).
5. Configurar ESLint + Prettier alineados con el repo (2 espacios, trailing comma "all",
   single quote, plugins TS).
6. Crear `.env.example` con las tres variables del §3.
7. Crear `src/types/assistance.ts` y `src/types/auth.ts` copiando los tipos del contrato.
8. Crear `src/lib/api/client.ts` (fetch wrapper con interceptor JWT y `ApiError`).
9. Crear `src/lib/api/auth.ts` con `login(email, password): Promise<LoginResponse>`.
10. Crear `src/stores/auth.store.ts` (Zustand: `token`, `user`, `setAuth`, `logout`).
    Persistir `token` en `localStorage` para sobrevivir recargas.
11. Implementar `LoginPage.tsx`: formulario email+password, llamada al endpoint
    `POST /herramientas/v1/auth/login`, guardar token+user en store, redirigir a `/queue`.
12. Implementar `<RequireAuth>` guard de ruta.
13. Configurar React Router con las rutas del §4; `App.tsx` con `<QueryClientProvider>` +
    `<RouterProvider>`.
14. Smoke test: `npm run dev` → pantalla de login funcional; login correcto redirige a
    `/queue` (que puede mostrar un placeholder); logout limpia el token y redirige a `/login`.

**DoD:** scaffold compila sin errores TS, lint limpio, login funcional contra el backend
real o mock, guard de ruta activo, pantalla 404 implementada.

---

### Etapa 2 — Layout base + routing completo

**Tareas:**
1. Crear el layout principal (`AppLayout.tsx`): sidebar/header con nombre del agente, rol,
   botón de logout, indicador de estado de conexión WS.
2. Crear `NotFoundPage.tsx`.
3. Configurar rutas completas del §4 dentro del layout.
4. Crear `QueuePage.tsx` y `SessionDetailPage.tsx` con contenido placeholder.

**DoD:** navegación entre rutas funciona; recarga en `/sessions/abc` no pierde el auth;
rutas no encontradas muestran 404.

---

### Etapa 3 — Cliente REST + cliente WS

**Tareas:**
1. Completar `src/lib/api/assistance.ts` con todas las funciones del §6.
2. Implementar `AssistanceSocket.ts` completo (§7.2): conexión, heartbeat, reconexión con
   backoff, subscribeQueue, joinSession, sendChat, off/on de eventos.
3. El socket se conecta automáticamente al hacer login (llamado desde `auth.store.ts` o
   desde `App.tsx` via `useEffect`); se desconecta al hacer logout.
4. Implementar `src/stores/session.store.ts` (§7.4).
5. Implementar hooks: `useQueue`, `useSession`, `useEvents`, `useActions` (§7.3).

**DoD:** consola de dev muestra WS conectado y mensajes `SUBSCRIBE_QUEUE` enviados al
hacer login. Si el backend emite `QUEUE_UPDATED`, el hook `useQueue` actualiza el cache de
React Query sin refetch HTTP. Reconexión automática verificable cortando y restaurando la
conexión.

---

### Etapa 4 — Vista Cola

**Tareas:**
1. Implementar `QueueTable.tsx` + `QueueRow.tsx`: lista paginada de sesiones con estado
   (`StatusBadge`), número de cuenta, razón, tiempo desde la solicitud.
2. Filtros: por `status` (select), por `accountNumber` (input).
3. Botón "Tomar" en filas con `status === 'QUEUED'` → llama `POST /sessions/{id}/assign`
   → al éxito, invalidar la query de cola y navegar a `/sessions/{id}`.
4. La cola se actualiza en tiempo real con eventos `QUEUE_UPDATED` (hook `useQueue`).
5. Paginación (page/pageSize).
6. Indicador visual de nueva sesión entrante (color/animación en la fila).

**DoD:** agente ve la cola en vivo; puede tomar una sesión; errores 409 (ya asignada)
muestran toast; la cola refleja cambios en < 2 s del evento WS.

---

### Etapa 5 — Detalle de sesión: estado, transiciones y notas

**Tareas:**
1. Implementar `SessionHeader.tsx`: muestra todos los campos de `AssistanceSession`,
   `StatusBadge` coloreado, botones de transición según el estado actual.
2. Lógica de transiciones disponibles por estado (tabla del contrato §2), visible solo
   para el AGENT asignado o SUPERVISOR.
3. Para transiciones que requieren `note` (RESOLVED/UNRESOLVED/CANCELLED), abrir un modal
   `NoteForm.tsx` antes de enviar.
4. `POST /sessions/{id}/status` → al éxito, invalidar query `['session', id]`.
5. `NoteForm.tsx` standalone (nota libre, sin cambio de estado) → `POST /sessions/{id}/notes`.
6. Las actualizaciones de estado llegan también por WS `SESSION_STATE_CHANGED`.

**DoD:** ciclo completo ASSIGNED → ACTIVE → RESOLVED navegable en UI; notas guardadas
aparecen en el timeline; errores 409 y 400 muestran mensaje específico.

---

### Etapa 6 — Visor del estudio WiFi (StudyTab)

**Tareas:**
1. Llamar `GET /sessions/{id}/study` con `useQuery` (sin suscripción WS; el estudio es
   un snapshot).
2. Renderizar `StudyPanel.tsx`: speedtest (download/upload con barras de progreso visual),
   tabla de pings (target, latencia, pérdida de paquetes), contadores de dispositivos LAN
   y WiFi, telemetría de planta (ONU RxPower, SNR con semáforo visual).
3. Si `latestHeatmapId` no es null, mostrar un enlace o imagen del heatmap usando la URL
   del backend (consultar con Franco si `GET /herramientas/v1/heatmap/{id}/image` existe).
4. Estado de carga y error claros; si el backend devuelve 404 (no hay estudio aún),
   mostrar mensaje "Aún no hay estudio disponible para esta cuenta".

**DoD:** el panel muestra datos reales de `GET /sessions/{id}/study`; nada de diagnóstico
se reimplementa en el portal; sin errores TS.

---

### Etapa 7 — Consola en vivo: video + acciones ACS + sesión remota (ConsoleTab)

**Tareas (sub-etapa 7a — Video):**
1. Implementar `VideoPanel.tsx`: botón "Iniciar video" → llama `POST /sessions/{id}/video`
   → monta `JitsiFrame` (§8) con `roomName`, `domain`, `jwt`.
2. Botón "Colgar" → desmonta `JitsiFrame` (`api.dispose()`).
3. Renovación de JWT de sala (botón "Reconectar video" si Jitsi External API emite evento
   de sala expirada).

**Tareas (sub-etapa 7b — Acciones ACS):**
1. Implementar `AcsActionsPanel.tsx`: lista de acciones disponibles (`REBOOT`, `SET_WIFI`,
   `SET_CHANNEL`, `FACTORY_RESET`, `REPROVISION`, `RUN_DIAGNOSTIC`).
2. Cada acción abre un mini-formulario con los params correspondientes (§4 del contrato).
3. `POST /sessions/{id}/actions` → `action.status = 'PENDING'` → mostrar spinner en la
   fila de la acción.
4. Evento WS `ACTION_RESULT` → actualizar `session.store` (resolveAction) → mostrar
   `SUCCESS` (verde) o `FAILED` con `result.message`.
5. Historial de acciones de la sesión (`GET /sessions/{id}/actions`) mostrado debajo.
6. Deshabilitar acciones si `session.status !== 'ACTIVE'`.

**Tareas (sub-etapa 7c — Sesión remota, MVP Opción C):**
1. Implementar `RemotePanel.tsx`:
   - Si no hay `activeRemoteSession`: formulario para introducir `targetHost` (IP del CPE),
     `ttlSeconds` (default 600), canal `BROKER_TUNNEL`. Botón "Abrir sesión remota".
   - Llamada a `POST /sessions/{id}/remote-sessions`.
   - Al recibir WS `REMOTE_SESSION_READY` (o respuesta HTTP 201): mostrar panel de estado.
   - Panel de estado: `targetHost`, tiempo restante hasta `expiresAt` (countdown), estado
     del técnico (`PEER_PRESENCE`), botón "Cerrar sesión remota" →
     `POST /remote-sessions/{rsId}/close`.
   - Banner de alcance: "La operación directa del panel del router estará disponible en
     la próxima versión. Usa las Acciones ACS para configurar el equipo."
2. Reconocer cierre del broker por WS (evento `SESSION_STATE_CHANGED` o ausencia de
   `PEER_PRESENCE` del técnico) y actualizar el estado del panel.

**DoD Etapa 7:** agente puede iniciar/colgar video Jitsi; ejecutar cualquier acción ACS y
ver el resultado en tiempo real; abrir y cerrar una sesión remota con confirmación visual
del estado del broker; todo sin reimplementar diagnóstico.

---

### Etapa 8 — Timeline de auditoría (TimelineTab)

**Tareas:**
1. `GET /sessions/{id}/events` con paginación (useInfiniteQuery o paginación manual).
2. Renderizar `EventTimeline.tsx`: lista cronológica de `AssistanceEvent`; cada tipo con
   icono y descripción legible (STATE_CHANGE, NOTE, ACTION, REMOTE_SESSION, CHAT, CONSENT).
3. Actualización en vivo: eventos nuevos llegan por WS `SESSION_STATE_CHANGED`, `ACTION_RESULT`,
   `CHAT_MESSAGE` — invalidar o prepend a la query de eventos.
4. Chat: input de texto → `sendChat(sessionId, text)` por WS → los mensajes propios y del
   técnico se muestran en el timeline tipo chat.

**DoD:** timeline muestra todos los tipos de evento; chat funciona en tiempo real; la
paginación carga eventos históricos.

---

### Etapa 9 — Accesibilidad y pulido final

**Tareas:**
1. Revisar con el skill `revision-a11y` (se ejecutará al final de esta etapa).
2. `aria-label` en elementos interactivos sin texto visible.
3. Navegación por teclado en formularios y botones.
4. Contraste de colores suficiente (WCAG AA).
5. Mensajes de error accesibles (`aria-live`).
6. `npm run build` limpio sin warnings.
7. `npm run lint` limpio.
8. Smoke test end-to-end: login → cola → tomar sesión → ver estudio → iniciar video →
   ejecutar acción ACS → abrir sesión remota → cerrar → timeline con todos los eventos.

**DoD:** build limpio, lint limpio, revisión a11y completada y observaciones aplicadas,
flujo completo navegable.

---

## 13. Riesgos y decisiones que requieren input de Franco

1. **Panel de sesión remota (decisión principal):** Se recomienda Opción C para Fase E
   (consola completa sin render del HTML del router). Si Xtrim requiere la navegación
   directa del panel para el lanzamiento, hay que planificar Fase E.2 con la Opción A,
   lo cual implica trabajo de backend adicional. **Necesito confirmación de Franco sobre
   si la Opción C es aceptable para el go-live de Fase E.**

2. **Tailwind en el portal:** el monorepo tiene Tailwind en el backend (no en el frontend
   de la app del técnico, que es vanilla). El portal puede usar Tailwind CSS (añadir como
   dev dependency + `tailwind.config.ts`) o una librería de componentes mínima (p.ej.
   `daisyUI` sobre Tailwind). **Franco debe confirmar si se agrega Tailwind al portal o si
   se usa otro enfoque de estilos.** Por defecto el plan asume Tailwind, que es el stack
   del monorepo.

3. **URL de imágenes del heatmap:** `StudyOverview` devuelve `latestHeatmapId`. Para
   mostrar el heatmap como imagen en el portal, se necesita saber si el backend expone
   `GET /herramientas/v1/heatmap/{id}/image` o equivalente. Si no existe, el visor de
   estudio muestra el ID pero no la imagen. **Confirmar con el especialista backend.**

4. **Jitsi self-host accesible desde el portal:** el dominio Jitsi (p. ej.
   `meet.wifix.internal`) debe ser alcanzable desde los navegadores de los agentes (no
   solo desde el LAN del técnico). Si está en Hetzner con DNS interno, los agentes del
   Call Center necesitan acceso por HTTPS. Esto es un requisito de infraestructura.
   **Franco debe confirmar que el Jitsi self-host está o estará accesible públicamente
   por HTTPS antes de Fase E.**

5. **Alcance del chat:** el contrato tiene `CHAT_MESSAGE` (WS bidireccional técnico ↔
   agente). La Etapa 8 lo incluye en el timeline. Si el chat requiere una UI más rica
   (historial persistente visible por separado, notificaciones, etc.), es una decisión
   de producto. Por ahora el plan lo integra en el timeline.

---

## 14. Resumen ejecutivo para Franco

El portal del Call Center es una SPA React+TS+Vite en `portal-callcenter/` dentro del
monorepo. Consume el mismo backend Fastify ya construido sin tocar nada del backend
existente (salvo confirmar la variable `CORS_ORIGIN` para el dominio del portal en
producción).

La única decisión crítica es el panel de sesión remota: se recomienda el MVP (Opción C)
para Fase E porque las Opciones A y B requieren trabajo de backend o ingeniería excesiva
que no cabe en el alcance actual. La consola queda 100 % operativa (video + ACS + control
de apertura/cierre del túnel) sin el render del HTML del router.

El diagnóstico WiFi (mapa de calor, speedtest, ping, traceroute, dispositivos) NO se
reimplementa en el portal. Todo llega de `GET /sessions/{id}/study`.

El plan tiene 9 etapas con checkpoints; `frontend` puede avanzar de forma autónoma desde
la Etapa 1 con este documento como guía única.
