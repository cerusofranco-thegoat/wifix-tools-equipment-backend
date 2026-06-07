# PROMPT · Claude Code — Wifix · Módulo Asistencia Técnica

> Pégame en Claude Code, en la raíz del repositorio **Wifix**.
> Ejecuta **una fase a la vez, en orden**. Al terminar cada fase, **detente en el checkpoint** y espera mi aprobación explícita antes de continuar.

---

## 1. Rol

Eres el ingeniero a cargo de implementar el **módulo Asistencia Técnica** dentro del backend existente de Wifix y de construir el **portal del Call Center**. Trabajas con disciplina de fases y checkpoints, reutilizando los patrones que ya existen en el repo (módulos, conectores, Zod, JWT, manejo de errores, paginación, Vitest).

**Asistencia Técnica NO es un backend aparte**: es un módulo más del mismo Fastify (como Herramientas y Equipos Retirados). El **portal** sí es una app de frontend separada, en el mismo monorepo, que consume el mismo backend.

---

## 2. Fuente de verdad (leer ANTES de tocar código)

Estos documentos ya están en el repo y son **autoritativos**. Léelos completos antes de empezar:

- `docs/Wifix_AsistenciaTecnica_Analisis_y_Arquitectura.md` — análisis de los repos heredados y la arquitectura.
- `docs/adr/asistencia-tecnica.md` — decisiones (ADR-0001 a 0006) con sus trade-offs.
- `docs/api/asistencia-tecnica.md` — **contrato de API** (REST + WebSocket). Es la fuente de verdad de endpoints, tipos y errores.
- `wifix_asistencia_tecnica.prisma` — fragmento del modelo de datos a fusionar en `backend/prisma/schema.prisma`.

Regla: si algo no calza con el contrato o un ADR, **se corrige el documento primero** (y se me avisa), no en silencio en el código.

---

## 3. Stack congelado (no cambiar sin mi aprobación previa)

- Backend: **Node 20 LTS · TypeScript ESM (`strict`) · Fastify 5 · Zod · Prisma 5 · PostgreSQL 15 · JWT HS256 (`jose`) + bcrypt · S3/MinIO (`@aws-sdk/client-s3`) · pino · Vitest**.
- Tiempo real: **`@fastify/websocket`** sobre el mismo servidor.
- Portal: **React + TypeScript + Vite** (ADR-0003).
- Video: **Jitsi Meet self-host** (ADR-0004).

No agregues dependencias nuevas fuera de esto sin proponérmelo y registrar un ADR.

---

## 4. Reglas de trabajo (críticas)

1. **Una fase a la vez, en orden.**
2. **Checkpoint obligatorio:** al terminar una fase, **PARA**, escribe un resumen de lo hecho, indica **cómo verificarlo** (comandos), y **espera mi confirmación** ("aprobado") antes de avanzar. **Nunca** pases de fase sin mi OK.
3. **No rompas lo existente** (Herramientas, Equipos Retirados, auth, media). Corre la suite Vitest existente antes y después de cada fase.
4. **Seguridad de primera clase** (ADR-0001/0002): sin secretos en código (todo a `.env` validado con Zod); **WSS/HTTPS**; **RBAC**; **auditoría** de toda acción; **consentimiento** del cliente como condición; sesiones remotas **acotadas en tiempo y a un solo CPE**; **jamás** exponer el router en una URL pública.
5. **Pruebas + lint limpios** antes de cada checkpoint. Cada fase añade sus pruebas Vitest y pasan.
6. **Idioma:** mensajes de error (`message`) en español, códigos (`code`) en inglés. Comentarios y nombres como el resto del repo.
7. **Usa los skills** según corresponda: `esquema-prisma`, `contrato-api`, `pruebas`, `revision-codigo` (y `revision-a11y` en el portal); `adr` si surge una decisión nueva.
8. **Pregunta solo lo que bloquee.** Si una decisión es ambigua y no está en los documentos, proponme opciones en el checkpoint en vez de adivinar.

---

## 5. Definition of Done (aplica a cada fase)

- [ ] Cumple el contrato (`docs/api/asistencia-tecnica.md`).
- [ ] Pruebas Vitest de la fase pasan; la suite previa sigue pasando.
- [ ] `lint` y `format` limpios.
- [ ] No rompe módulos existentes.
- [ ] Resumen de cambios + comandos de verificación en el checkpoint.

---

## 6. Mapa de fases

> La **Fase A (diseño: contrato + ADRs + esquema) ya está hecha** y es el insumo. La **implementación** arranca en la **Fase 0** y va en orden hasta la **Fase F**.

| Orden | Fase | Objetivo | Checkpoint |
|------|------|----------|------------|
| 1 | **Fase 0** | Preparación: roles, fusión de esquema, migración, scaffold del módulo y del WS | Apruebo la base |
| 2 | **Fase B** | Sesiones + ciclo de vida + WebSocket (ACS y broker en mock) | Apruebo el flujo |
| 3 | **Fase C** | Acciones de equipo reales vía ACS/TR-069 | Apruebo acciones |
| 4 | **Fase D** | Sesión remota intermediada (broker WSS) + Jitsi | Apruebo seguridad y enfoque |
| 5 | **Fase E** | Portal del Call Center (React+TS+Vite) | Apruebo el portal |
| 6 | **Fase F** | Conectores de operadora + auto-asistencia + retiro de Proxy Xtrim | Apruebo y cierre |

---

## 7. Fases

### Fase 0 — Preparación del módulo

**Objetivo:** dejar la base lista sin lógica de negocio.

**Tareas:**
1. Leer los cuatro documentos de la sección 2 y confirmar la estructura actual del backend (`backend/src/...`) y sus convenciones.
2. **Roles (RBAC):** añadir al modelo `User` existente un enum `UserRole { TECHNICIAN AGENT SUPERVISOR }` con campo `role` (default `TECHNICIAN`). Añadir un helper de guard `requireRole(...)` que se apoye en el middleware `authenticate` existente.
3. **Esquema:** fusionar el contenido de `wifix_asistencia_tecnica.prisma` en `backend/prisma/schema.prisma` (enums + `AssistanceSession`, `AssistanceEvent`, `RemoteAction`, `RemoteSession`, `ConnectorCallLog`, `LegacyScan`) y añadir la relación inversa en `MediaFile` para las grabaciones. Generar **una** migración con nombre descriptivo (`add_assistance_module`). Revisar el SQL antes de aplicar.
4. **Seed:** extender `prisma/seed.ts` para fijar el `role` del usuario sembrado y crear (solo en dev) un técnico y un agente de prueba. Mantener idempotencia.
5. **Scaffold del módulo:** crear `src/modules/assistance/` siguiendo el patrón de los otros módulos (routes/service/repository/schemas/mappers), con handlers en stub. Registrar las rutas bajo el prefijo **`/asistencia/v1`** en `app.ts`.
6. **WebSocket:** registrar `@fastify/websocket`; crear la ruta `/asistencia/v1/ws` que **autentica el JWT** y acepta la conexión (sin lógica de negocio todavía).

**Aceptación / checkpoint:** mostrar el SQL de la migración, el árbol del módulo nuevo, el servidor arrancando, `GET /health` OK, la lista de rutas registradas y que la suite previa sigue verde.

---

### Fase B — Sesiones + ciclo de vida + WebSocket (mock)

**Objetivo:** el módulo funcional de extremo a extremo con ACS y broker simulados.

**Tareas:**
1. Implementar los endpoints REST de **sesiones** del contrato: `POST /sessions`, `GET /sessions` (cola, paginada, con guard de rol), `GET /sessions/{id}`, `POST /sessions/{id}/assign`, `POST /sessions/{id}/status`, `GET /sessions/{id}/events`, `POST /sessions/{id}/notes`.
2. **Máquina de estados** estricta (ver contrato §2): validar transiciones y devolver `409 CONFLICT` ante transiciones inválidas. `EXPIRED` lo aplica un job por timeout, no el endpoint.
3. **Auditoría:** escribir un `AssistanceEvent` en cada cambio de estado, nota, acción y evento de sesión remota. **Consentimiento** obligatorio para crear la solicitud y condición para abrir sesión remota.
4. **Gateway WebSocket:** manejar mensajes cliente→servidor (`REGISTER_TECHNICIAN`, `SUBSCRIBE_QUEUE`, `JOIN_SESSION`, `CHAT_MESSAGE`, `HEARTBEAT`) y emitir eventos servidor→cliente (`QUEUE_UPDATED`, `SESSION_STATE_CHANGED`, `CHAT_MESSAGE`, `PEER_PRESENCE`, `ERROR`), validando rol y pertenencia a la sesión. Cerrar conexión y marcar offline si falta el `HEARTBEAT`.
5. **Endpoints de acción/sesión remota/video presentes pero en MOCK:** `POST /sessions/{id}/actions` (usa el `acsMock` existente), `POST /sessions/{id}/remote-sessions` (devuelve token/URL simulados), `POST /sessions/{id}/video` (sala simulada). Emitir `ACTION_RESULT` y `REMOTE_SESSION_READY` por WS.
6. **Pruebas:** transiciones válidas/ inválidas, guards de rol, gating por consentimiento, auth del WS, `QUEUE_UPDATED` al crear/cambiar sesiones.

**Checkpoint:** demo del flujo solicitud→cola→asignación→activa→cierre y eventos por WS; pruebas verdes.

---

### Fase C — Acciones de equipo reales (ACS / TR-069)

**Objetivo:** ejecutar acciones reales contra el ACS donde el equipo lo soporte.

**Tareas:**
1. Extender la interfaz del conector `acs` (y su mock + esqueleto real) con: `reboot`, `setChannel`, `factoryReset`, `reprovision`, `runDiagnostic` (ping/traceroute en formato TR-143, reutilizando el formato de las herramientas).
2. Conectar `POST /sessions/{id}/actions` al conector real (modo `real`), con estados `PENDING → SUCCESS | FAILED`, resultado persistido en `RemoteAction` y emitido por WS (`ACTION_RESULT`). `502 CONNECTOR_ERROR` si el ACS no responde o el equipo no soporta la acción.
3. Mantener `SET_WIFI` consistente con el `updateWifiConfig` ya existente.
4. **Pruebas:** cada acción, manejo de error del conector, idempotencia/determinismo del mock.

**Checkpoint:** acciones reales (o contra el mock determinista si aún no hay credenciales) con resultados auditados; pruebas verdes.

---

### Fase D — Sesión remota intermediada (broker WSS) + Jitsi

**Objetivo (pieza de mayor riesgo):** reemplazar el túnel público por un broker seguro y auditado.

**Tareas:**
1. **Broker:** la app del técnico abre una conexión **WSS saliente** registrando un túnel **por sesión**; el agente, autenticado, abre la sesión remota con un **token de un solo uso, de vida corta y con alcance a un único CPE/sesión**; el broker **multiplexa HTTP(S)** del agente hacia el panel del router a través del túnel del técnico. Definir aquí el **protocolo de trama** del túnel.
2. **Controles de seguridad (ADR-0002):** token single-use + `ttlSeconds`; cierre automático al expirar, al cerrar la sesión, o cuando la app del técnico pasa a segundo plano; **auditoría** de cada request del agente por el túnel; **grabación opcional** a `MediaFile` (`RemoteSession.recordingId`). Cero exposición pública del router.
3. **Jitsi:** provisión real de sala + firma del JWT de sala en `POST /sessions/{id}/video` contra el Jitsi self-host (config por `.env`).
4. **Revisión de seguridad** con el skill `revision-codigo` enfocada en el broker (alcance, expiración, fuga de credenciales, SSRF hacia la red del cliente).
5. **Pruebas:** ciclo del token (uso único, expiración), alcance a un CPE, denegación a sesiones ajenas, auto-cierre.

**Checkpoint:** sesión remota real y segura sobre el broker; revisión de seguridad documentada; pruebas verdes.

---

### Fase E — Portal del Call Center (React + TS + Vite)

**Objetivo:** la consola del agente, consumiendo el backend.

**Tareas:**
1. Scaffold de `portal-callcenter/` (Vite + React + TS) en el monorepo. Login contra el mismo backend (JWT).
2. Vistas: **cola** de solicitudes (en vivo por WS), **detalle de sesión**, **visor del estudio WiFi** (`GET /sessions/{id}/study`: mapa de calor, speedtest, pings, dispositivos, telemetría de planta), **consola en vivo** (video Jitsi + botones de acciones ACS + panel de sesión remota), **timeline de auditoría**.
3. Consumir REST + WebSocket del contrato. Manejo de estados y reconexión del WS.
4. **Accesibilidad/UX** con el skill `revision-a11y`. Build y lint limpios.

**Checkpoint:** portal navegable de extremo a extremo contra el backend; un agente puede tomar una sesión, ver el estudio, abrir video, ejecutar una acción ACS y abrir la sesión remota.

---

### Fase F — Conectores de operadora + auto-asistencia + retiro de Proxy Xtrim

**Objetivo:** cerrar la integración con la operadora y la automatización.

**Tareas:**
1. **Conectores** (mock→real) plegando el catálogo de Proxy Xtrim (ADR-0005): nuevo `ticketing` (`GeneraTicket`/`ObtieneTicket`/`...BackOffice`/`RetiroAnticipado`), nuevo `scheduling` (turnos), extender `fsm` (órdenes `CreaFsmVistec`/`FsmOrdenes`/cancelación) e `ispmonitor` (telemetría de planta `OnuRxPower`/`networksnr`/`cablemodem*`), mapear cuentas a `comarch`.
2. **Auditoría de conectores:** envolver toda llamada a conectores para registrar en `ConnectorCallLog` (servicio, operación, status, tiempos, actor).
3. `POST /sessions/{id}/tickets` y la telemetría de planta dentro de `GET /sessions/{id}/study`.
4. **Motor de auto-asistencia:** correr estudio + telemetría → detectar causas (señal baja, SNR malo, canal saturado, ONU con RxPower fuera de rango) → **proponer** y, con consentimiento, **aplicar** remediaciones vía ACS; reversible y auditado.
5. **Retiro de Proxy Xtrim:** mover catálogo y credenciales reales a `.env` por conector; coordinar el corte con quien hoy consume el proxy.
6. **Opcional (ADR-0006):** si el backend "mirror" de Wifi Monitor tiene volumen real, ETL único a `LegacyScan` (idempotente por `legacyId`); si no, descartar.
7. **Pruebas:** conectores, logging de auditoría, reglas del motor de auto-asistencia.

**Checkpoint final:** integración con la operadora operativa, auto-asistencia funcionando, Proxy Xtrim retirado; pruebas verdes y resumen de cierre.

---

## 8. Qué NO hacer

- No reimplementar el diagnóstico WiFi (speedtest, ping, traceroute, mapa de calor, dispositivos): **reutilizar** lo de `/herramientas/v1`.
- No exponer el panel del router en una URL pública ni usar `localtunnel`/`socket-tunnel` heredados.
- No introducir secretos ni tokens en el código.
- No tocar otros módulos salvo lo indicado (añadir `role` a `User`, relación inversa en `MediaFile`).
- No avanzar de fase sin mi confirmación en el checkpoint.
