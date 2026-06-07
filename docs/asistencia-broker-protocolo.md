# Wifix · Asistencia Técnica — Protocolo de trama del broker WSS

Versión: 1.0 (Fase D)
Estado: implementado

---

## 1. Contexto y motivación

El broker de sesión remota es la pieza central de ADR-0002. Reemplaza `socket-tunnel`/`localtunnel` por un canal seguro y acotado. El router del cliente vive detrás de NAT; la app del técnico (Capacitor) está en el LAN del cliente y sí puede alcanzar el panel del router. El agente del Call Center no puede llegar directamente; el broker hace de intermediario.

## 2. Arquitectura del flujo

```
[Agente] ──WSS──▶ /asistencia/v1/broker/connect?sessionToken=<jwt>
                        │
                   [Broker Wifix]
                        │
[Técnico] ──WSS──▶ /asistencia/v1/broker/tunnel
                   (ya autenticado con REGISTER_TUNNEL)
                        │
                        ▼
               [Panel del router - LAN cliente]
               (resolve del lado del técnico)
```

La resolución DNS y la conexión TCP al `targetHost` se hace **del lado del técnico**, no del servidor del broker. El broker solo multiplexa las tramas JSON; nunca abre conexiones TCP a hosts externos.

## 3. Protocolo de trama

### 3.1 Transporte

- **WebSocket** (wss://) sobre el mismo servidor Fastify.
- Cada mensaje = un objeto JSON en texto (`send(JSON.stringify(frame))`).
- No se usa framing binario en esta versión (base64 para body).

### 3.2 Tipos de trama

| Tipo | Dirección | Descripción |
|------|-----------|-------------|
| `OPEN_STREAM` | Agente → Técnico (vía broker) | Inicia un "stream" para una petición HTTP |
| `DATA` | Bidireccional | Fragmento de body (request o response) en base64 |
| `END_STREAM` | Bidireccional | Fin de datos del stream |
| `RESPONSE` | Técnico → Agente (vía broker) | Cabeceras + status HTTP del router |
| `ERROR` | Cualquier dirección | Error de stream o de protocolo |
| `PING` | Broker → Técnico | Keep-alive del túnel |
| `PONG` | Técnico → Broker | Respuesta a PING |

### 3.3 Definición de campos

#### OPEN_STREAM (Agente → Técnico)
```json
{
  "type": "OPEN_STREAM",
  "streamId": 1,
  "method": "GET",
  "path": "/login",
  "headers": { "Accept": "text/html" }
}
```
- `streamId`: entero positivo único por sesión del agente. Identificador de multiplexación.
- `method`: GET | POST | PUT | DELETE | HEAD | OPTIONS | PATCH (solo estos permitidos).
- `path`: ruta en el panel del router. El `targetHost` lo fija el broker a partir del token; el agente NO puede cambiarlo.
- `headers`: cabeceras HTTP a enviar al router. Las cabeceras sensibles (Authorization, Cookie) son redactadas por el broker antes de pasar al técnico y antes de auditar.

#### DATA (Bidireccional)
```json
{
  "type": "DATA",
  "streamId": 1,
  "data": "<base64-encoded-chunk>"
}
```
- El body se fragmenta en chunks de 64 KB para evitar mensajes WS muy grandes.
- El técnico acumula los chunks hasta recibir END_STREAM.

#### END_STREAM (Bidireccional)
```json
{
  "type": "END_STREAM",
  "streamId": 1
}
```
- Señala fin de datos (fin de request del agente, o fin de response del router).

#### RESPONSE (Técnico → Agente)
```json
{
  "type": "RESPONSE",
  "streamId": 1,
  "status": 200,
  "headers": { "Content-Type": "text/html" }
}
```
- Se envía antes de los DATA del response. Es el equivalente al status line + headers de HTTP.

#### ERROR
```json
{
  "type": "ERROR",
  "streamId": 1,
  "code": "TIMEOUT",
  "message": "El router no respondió en el tiempo esperado."
}
```
- `streamId`: null si es error de protocolo (no de un stream específico).
- Si el técnico no puede alcanzar el router para un stream, envía ERROR con ese streamId.

#### PING / PONG
```json
{ "type": "PING", "at": 1720000000000 }
{ "type": "PONG", "at": 1720000000000 }
```
- El broker envía PING cada 30 segundos al técnico. El técnico responde PONG.
- Independiente del heartbeat del WS de señalización (que es cada 60s).

### 3.4 Ciclo de vida de un stream

```
Agente                Broker                 Técnico              Router
  │                     │                      │                    │
  │──OPEN_STREAM(1)────▶│──OPEN_STREAM(1)─────▶│                    │
  │──DATA(1, body)─────▶│──DATA(1, body)───────▶│                    │
  │──END_STREAM(1)─────▶│──END_STREAM(1)───────▶│──HTTP request─────▶│
  │                     │                      │◀──HTTP response────│
  │                     │◀──RESPONSE(1,200)────│                    │
  │◀──RESPONSE(1,200)───│                      │                    │
  │                     │◀──DATA(1, b64chunk)──│                    │
  │◀──DATA(1, b64chunk)─│                      │                    │
  │                     │◀──END_STREAM(1)──────│                    │
  │◀──END_STREAM(1)─────│                      │                    │
```

### 3.5 Multiplexación

Múltiples streams pueden estar en vuelo simultáneamente sobre el mismo túnel WSS. Cada uno se identifica por `streamId`. El broker enruta tramas del técnico al agente correcto usando un EventEmitter keyed por `sessionId+streamId`.

Restricción: el agente solo puede abrir nuevos streams con `OPEN_STREAM`. DATA y END_STREAM del agente son manejados internamente por el proxy (`broker.proxy.ts`).

## 4. Backpressure y timeouts

- **STREAM_TIMEOUT_MS = 20 000 ms**: si el técnico no envía `RESPONSE` en 20 segundos, el broker resuelve el stream con error `TIMEOUT` al agente.
- **MAX_BODY_SIZE_BYTES = 4 MB**: si la respuesta acumulada supera 4 MB, el stream se aborta con error `BODY_TOO_LARGE`.
- Si el túnel del técnico se cierra mientras hay streams activos, todos los streams pendientes reciben `ERROR { code: "TUNNEL_CLOSED" }`.

## 5. Seguridad del broker (ADR-0002)

### 5.1 Token de sesión remota (uso único)

- JWT HS256 firmado con `BROKER_TOKEN_SECRET` (distinto de `JWT_SECRET` del auth).
- Payload: `{ sub: agentId, jti: uuid, sessionId, remoteSessionId, targetHost, iat, exp }`.
- El `jti` se registra en `broker.token-store.ts` y se **consume al primer uso**.
- Intentos de reutilización → `ALREADY_USED → 401`.
- El TTL es el `ttlSeconds` de `POST /sessions/{id}/remote-sessions` (1..1800 s, default 600 s).

### 5.2 Defensa SSRF (política de targetHost)

El agente NO puede dirigir el broker a un host arbitrario. La validación se aplica en `broker.ssrf-guard.ts` al abrir la sesión remota:

**PERMITIDO:**
- IPs privadas RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
- Puertos: solo **80** y **443**.
- Esquemas: solo **http** y **https**.
- Solo **direcciones IP** (no hostnames DNS arbitrarios).

**BLOQUEADO explícitamente:**
- Loopback: `127.0.0.0/8`, `::1`.
- Link-local: `169.254.0.0/16` (incluye `169.254.169.254` — AWS IMDS), `fe80::/10`.
- Hostnames bloqueados: `localhost`, `metadata.google.internal`, `metadata`, `169.254.169.254`, `fd00:ec2::254`.
- Cualquier hostname que no sea una IP literal (previene DNS rebinding).
- IPs públicas (cualquier IPv4 fuera de RFC 1918).
- Puertos distintos de 80 y 443.
- Esquemas distintos de http/https.

El `targetHost` queda fijo en el token desde la apertura. El agente no puede cambiarlo a mitad de sesión porque el broker usa el `targetHost` del token (no el de cada trama OPEN_STREAM).

### 5.3 Autenticación del técnico en el túnel

- JWT del sistema (mismo `JWT_SECRET` que el auth normal).
- Rol obligatorio: `TECHNICIAN`.
- Primer mensaje: `{ type: "REGISTER_TUNNEL", sessionId }`.
- Verifica que el `technicianId` de la sesión en BD coincide con el `sub` del JWT.
- Verifica que la sesión está en estado `ACTIVE`.

### 5.4 Auto-cierre (3 disparadores)

| Disparador | Mecanismo |
|-----------|-----------|
| TTL expirado | Timer individual por sesión remota (broker.expiry.ts) → status EXPIRED |
| Sesión de asistencia cerrada (RESOLVED/UNRESOLVED/CANCELLED) | Hook en `changeStatus()` → cierra RemoteSession + túnel |
| App del técnico sin heartbeat (segundo plano) | Stale check del WS señalización cada 15s → cierra RemoteSession + túnel |

### 5.5 Auditoría

Cada request HTTP proxeado por el túnel se registra como `AssistanceEvent` de tipo `REMOTE_SESSION` con payload `{ kind: "tunnel_request", method, path, targetHostLabel, responseStatus, durationMs, errorCode }`.

**No se registran** en auditoría: cookies, tokens de sesión del router, bodies de request/response, credenciales en cabeceras (redactadas con `[REDACTED]`).

### 5.6 Grabación opcional

Si `BROKER_RECORDING_ENABLED=true`, el broker crea un esqueleto de `MediaFile` al abrir la conexión del agente y enlaza `RemoteSession.recordingId`. El contenido completo de grabación (stream de pantalla) se conecta en Fase E con el cliente Capacitor.

### 5.7 Cero exposición pública del router

El router nunca recibe conexiones directas desde Internet. El tráfico va:
`agente (portal web) → broker Wifix (TLS) → túnel WSS → técnico (app Capacitor, LAN) → router`.

El técnico es el único que abre conexiones TCP al router; el broker nunca lo hace.

## 6. Conexión del agente (flujo completo)

1. AGENT llama `POST /sessions/{id}/remote-sessions` → recibe `{ wsUrl, sessionToken, expiresAt }`.
2. AGENT conecta a `wss://<host>/asistencia/v1/broker/connect?sessionToken=<jwt>`.
3. Broker verifica y consume el token (uso único).
4. Broker verifica que el técnico tiene un túnel activo (`REGISTER_TUNNEL` ya enviado).
5. Broker responde `{ type: "BROKER_READY", sessionId, remoteSessionId }`.
6. AGENT envía `OPEN_STREAM` para cada petición al router.
7. Broker reenvía al técnico, recibe respuesta, devuelve al agente.
8. Sesión termina por TTL / cierre manual / heartbeat perdido.

## 7. Harness de prueba (sin app Capacitor real)

Para ejercitar el flujo end-to-end en tests sin la app Capacitor:

```typescript
// 1. Conectar como técnico al túnel (simulado)
const techSocket = new WebSocket('ws://localhost:8080/asistencia/v1/broker/tunnel', {
  headers: { Authorization: `Bearer ${techJwt}` },
});
techSocket.on('open', () => {
  techSocket.send(JSON.stringify({ type: 'REGISTER_TUNNEL', sessionId }));
});

// 2. Responder a OPEN_STREAM como si fuera el router
techSocket.on('message', (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type === 'OPEN_STREAM') {
    // Simular respuesta del router
    techSocket.send(JSON.stringify({ type: 'RESPONSE', streamId: frame.streamId, status: 200, headers: {} }));
    techSocket.send(JSON.stringify({ type: 'DATA', streamId: frame.streamId, data: Buffer.from('<html>Router mock</html>').toString('base64') }));
    techSocket.send(JSON.stringify({ type: 'END_STREAM', streamId: frame.streamId }));
  }
});

// 3. Conectar como agente
const agentSocket = new WebSocket(`ws://localhost:8080/asistencia/v1/broker/connect?sessionToken=${sessionToken}`);
agentSocket.on('open', () => {
  agentSocket.send(JSON.stringify({ type: 'OPEN_STREAM', streamId: 1, method: 'GET', path: '/', headers: {} }));
});
agentSocket.on('message', (data) => {
  const frame = JSON.parse(data.toString());
  // frame.type === 'RESPONSE' → status 200
  // frame.type === 'DATA' → body base64
  // frame.type === 'END_STREAM' → done
});
```

Los tests de Vitest de Fase D prueban la lógica pura (token store, SSRF guard, framing, expiry) sin WS real ni Postgres.
