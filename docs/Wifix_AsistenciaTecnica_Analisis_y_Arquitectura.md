# Wifix · Módulo Asistencia Técnica
## Análisis de los repositorios heredados y arquitectura de migración

**Tulpa Solutions S.A.S.** · Documento de Fase 0 (discovery + arquitectura) · para revisión y aprobación antes de implementar.

Este documento es el resultado de leer los cuatro repositorios (`WIFI_MONITOR`, `Portal_Wifix`, `PROXY_XTRIM`, `Wifix_App`). No contiene código de implementación: define **qué hace hoy cada sistema**, **cómo funcionaba realmente la asistencia remota**, **qué ya está resuelto en la app nueva (para no duplicarlo)** y **la arquitectura recomendada** para el módulo de Asistencia Técnica y el nuevo portal del Call Center, con un plan por fases con checkpoints.

---

## 1. Resumen ejecutivo

- **Wifi Monitor (alias "HomeScanPro")** es la app legada del técnico: **Quasar/Vue 0.17 + Cordova**, con escaneo WiFi, speedtest, descubrimiento de dispositivos del LAN, video con **Jitsi**, y — la pieza central — un **Node.js embebido en el teléfono** (`nodejs-mobile`) que abre un **túnel** exponiendo el panel web del router para que el Call Center lo opere.
- **Portal Wifix** es el portal del Call Center: **Angular 7 + CoreUI** (2018-2019). Su "asistencia remota" es literalmente un **`<iframe>` apuntando a una URL pública de túnel** (`router6.localtunnel.me`).
- **Proxy Xtrim** **no es un túnel a routers**: es un **gateway HTTP con auditoría (NestJS)** delante de los backends de la operadora (Grupo TVCable / Xtrim) para cuentas, facturación, **telemetría de planta (ONU/cablemodem)**, tickets, órdenes FSM y agendamiento de turnos.
- **Wifix App (nueva)** ya tiene un **backend sólido en el stack congelado** (Fastify 5 / Prisma 5 / PostgreSQL 15 / JWT / MinIO) que implementa los 27 campos, una **capa de conectores** (incluido **ACS / TR-069**) y **todas las herramientas de diagnóstico** (speedtest, ping, traceroute, mapa de calor multi-AP, equipos retirados, dispositivos LAN/WiFi, lectura **y escritura** de configuración WiFi). El frontend del técnico es **Capacitor 6 + HTML/CSS/JS vanilla**, hoy con datos mockeados. **No existe todavía un portal nuevo del Call Center.**

**Dirección recomendada:** la app nueva ya reemplaza casi todo el *diagnóstico* de Wifi Monitor. Lo que falta migrar y construir es el **sistema de asistencia en vivo** (ciclo de la sesión, señalización en tiempo real, acciones sobre el equipo, video y auto-asistencia) y un **portal del Call Center moderno**. La recomendación es **reconstruir, no portar**, apoyándose en dos planos: (a) **acciones de equipo vía ACS/TR-069** (lo seguro y estándar, ya semiconstruido) y (b) una **sesión remota segura y auditada** que reemplaza al `iframe`+`localtunnel` público.

---

## 2. Qué es realmente cada repositorio

| Repo | Rol | Stack | Estado |
|------|-----|-------|--------|
| `WIFI_MONITOR` | App del técnico (legada) | Quasar 0.17 / Vue + Cordova; nodejs-mobile; Jitsi | Producción antigua |
| `Portal_Wifix` | Portal del Call Center (legado) | Angular 7 + CoreUI + jQuery/datatables | Producción antigua |
| `PROXY_XTRIM` | Gateway a la operadora + logs | NestJS 8 + Sequelize/MySQL + axios | Vigente (operadora) |
| `Wifix_App` | App nueva (objetivo de migración) | Backend Fastify 5/Prisma 5/PG 15; webapp Capacitor 6 + vanilla | En construcción |

### 2.1 Wifi Monitor — `com.cerusofranco.wifimonitor` (productName: HomeScanPro)
App híbrida **Quasar/Vue + Cordova**. Toda la UI vive en `src/pages/Index.vue` y `src/layouts/` (`AfterScan.vue` es la pantalla post-escaneo, donde se dispara la asistencia). Dependencias relevantes: `network-js` (speedtest/latencia en JS), `libnmap`/`node-nmap` y `@network-utils/arp-lookup` (descubrimiento de dispositivos del LAN), `ipinfo` (IP pública/geo), `node-openvpn`, `vue-recaptcha`. Plugins Cordova clave: `cordova-plugin-wifi` (escaneo WiFi), **`jitsiPlugin`** (video WebRTC), y un proyecto **`nodejs-mobile`** corriendo Node en el propio teléfono.

El estudio WiFi que generaba (deducido de `src/js/mirror.js` y del esquema `Scan`) incluía: SSID/BSSID, IP del equipo y del gateway, IP pública, **señal en dBm**, **tres pings** (a Google, al ISP y al router), **speedtest** (download/upload), latencia, y **lista de dispositivos conectados** al LAN.

Detalle importante: en `src/js/mirror.js` ya existe un **"mirror"** que envía cada estudio (fire-and-forget) a un **backend nuevo en Next.js 15 + Prisma 6** (`/api/scans`), señal de que ya empezaste la modernización de este flujo por separado.

### 2.2 Portal Wifix — Call Center (legado)
**Angular 7 + CoreUI** sobre plantilla de admin, con `jquery` + `datatables` + `chart.js` + `ngx-bootstrap`. Módulos reales (descartando el scaffolding de la plantilla y restos de "materia-prima"/"materiales" de otro proyecto): **tickets** (crear/listar/ver/ver-scan), **scans** (ver el estudio WiFi), **contrato** (cuentas), y **`tunnel`** — la asistencia remota.

El backend de este portal es **HomeScan** (`api.homescan.coserdisa.com`): `/login`, `/tickets`, `/tickets/:id`, `/tickets/:id/scan/:idScan`, `/tickets/:id/close`, `/tickets/dataTable`, `/tickets/scanDataTable`.

### 2.3 Proxy Xtrim — gateway a la operadora
**NestJS 8** con un endpoint genérico `POST /api/xtrim/callService` que toma `{ service, payload }`, lo busca en un **catálogo** (`xtrimWebServices`), reenvía la llamada al backend de la operadora con headers fijos, y **registra todo** en una tabla `proxy_logs` (servicio, payload, respuesta, status, tiempos). El catálogo revela las operaciones reales, agrupadas por backend:

- **API_BASE (`api.grupotvcable.com:9007`) — CRM / facturación / ticketing / FSM:** `buscarCuentas`, `ObtieneFacturas`, `ObtenerPropiedades(Cuenta)`, `crea/ModificarPropiedades`, `ObtieneTicket`/`GeneraTicket`/`ObtieneTicketBackOffice`, `RetiroAnticipado`, `FsmOrdenes`/`FsmOrdenCancelacion`/`CreaFsmVistec`/`FlujoPendiente`.
- **API_NETWORKS (`200.63.212.5:8080`) — telemetría de planta:** `terminals`, `networkdrops`, **`OnuRxPower`** (potencia óptica ONU → GPON), `networksnr`, `networkutilization`, `cablemodemdrops`/`cablemodemsnr`/`cablemodemcodewords` (DOCSIS/HFC), `cpes`.
- **API_TURNS (`turnos.netbot.ec`) — agendamiento:** `GetHorarios`, `Get/Create/CierraTurnoCliente`.

**Conclusión clave:** el "diagnóstico remoto del equipo" del cliente venía de la **telemetría de la operadora** (RxPower/SNR/drops de la ONU o cablemodem), no de entrar al router. Y la "conexión a routers antiguos" que mencionabas la hacía el **túnel** de Wifi Monitor (sección 3), no este proxy. Este proxy es la fuente de verdad del **contrato de integración con la operadora**.

### 2.4 Wifix App (nueva) — estado actual
Monorepo con `backend/` y `wifix-webapp/`.

**Backend** (`backend/README.md` + `schema.prisma`): exactamente el stack congelado — **Node 20 · TypeScript ESM · Fastify 5 · Zod · Prisma 5 · PostgreSQL 15 · JWT (jose) + bcrypt · S3/MinIO · pino · Vitest**. Arquitectura limpia por módulos y una **capa de conectores** con modo `mock|real`:

| Conector | Sistema real | Campos |
|----------|--------------|--------|
| `comarch` | TYTAN / Comarch CM | 1-5, 7 |
| `fsm` | FSM | 15, 16 |
| `ispmonitor` | ISP Monitor | 9-13 |
| **`acs`** | **ACS (TR-069)** | **19, 20, 21** |
| `tec` | TEC / registro GPON | 6, 8 |
| `rms` | RMS | 14 |

**Frontend** (`wifix-webapp`): **Capacitor 6 + HTML/CSS/JS vanilla** (sin build), con plugins nativos de **escáner de código de barras (ML Kit)**, cámara, **OCR de texto (ML Kit)**, geolocalización, device y network. Menú: Instalaciones y Visitas Técnicas. Datos mockeados en `app.js`.

---

## 3. El mecanismo de asistencia remota, decodificado

De `nodejs-project/main.js` (Node embebido en el teléfono) y `Portal_Wifix .../tunnel/ver.component.ts`, el flujo legado completo es:

1. El técnico, **conectado al WiFi del cliente**, corre el estudio en HomeScanPro.
2. Para asistencia, el Node embebido usa **`socket-tunnel`** y se conecta a un servidor propio **`tunnelsmartsense.com`**, exponiendo el **puerto 80 del gateway (el router)** bajo un **subdominio aleatorio** (`tunnel-XXXXXXXX`). Devuelve una URL pública.
3. El **Portal del Call Center carga esa URL en un `<iframe>`** → el agente ve y opera el **panel web nativo del router** directamente.
4. **Señalización en tiempo real con socket.io** (`pingapi.smartsense-ec.com`): el técnico se une a una **sala** identificada por el código del estudio; el Call Center emite eventos:
   - `activate-support` → activa un tipo de soporte.
   - `wifix-autoassistance` → **auto-asistencia** (remediación automatizada propuesta/aplicada).
5. **Jitsi** provee el canal de **video/voz** técnico ↔ agente.
6. En paralelo, los datos de cuenta/telemetría/tickets vienen de la operadora vía **Proxy Xtrim**.

> El "programa que hizo la conexión sencilla a routers antiguos" = **`socket-tunnel` + `localtunnel` corriendo en `nodejs-mobile`, más el `iframe` del portal**. Ingenioso, pero hoy inaceptable en seguridad (sección 4).

---

## 4. Hallazgos de seguridad (heredados — **no migrar estas prácticas**)

| Hallazgo | Dónde | Severidad | Nota |
|----------|-------|-----------|------|
| Panel web del router **expuesto público por HTTP** | túnel + `iframe` | **Crítico** | Sin auth en el túnel; subdominio adivinable (`router6`); mixed content. |
| **JWT hardcodeado** de la operadora en el fuente | `proxy_xtrim .../xtrim/constants.ts` | **Crítico (práctica)** | Token ya **expirado** (`exp` ago-2023): no hay fuga activa, pero el patrón debe morir. |
| **JWT hardcodeado** ("tokenQuemado") | `portal .../scan.service.ts` | Alto | Expirado (feb-2019). Literalmente nombrado "quemado". |
| **Bearer token** de TVCable en config de la app | `wifi-monitor .../api.js` (runtimeConfig) | Alto | Mover a secretos del backend, nunca al cliente. |
| **CORS `*`** y todo en **HTTP** | portal y backends legados | Alto | El stack nuevo ya corrige esto (HTTPS, auth Bearer, validación Zod). |

En la app nueva los secretos ya se validan con Zod al arrancar y viven en `.env`/secretos; mantener esa disciplina y **no reintroducir** tokens en el código ni exponer el router públicamente.

---

## 5. Qué ya está construido en la app nueva (NO duplicar)

El backend nuevo **ya reemplaza la mayor parte del diagnóstico** de Wifi Monitor. Antes de construir Asistencia Técnica, esto ya existe y debe **reutilizarse**, no rehacerse:

- **Herramientas:** speedtest, ping (con vínculo a habitación del mapa de calor), traceroute (con hops), **mapa de calor multi-AP** (`WifiHeatmap` / `WifiHeatmapRoom` / `WifiAccessPoint` / `RoomApMeasurement` a nivel BSSID), medición de distancia.
- **Equipos retirados:** modelo, motivo, foto de código de barras, validaciones.
- **Diagnóstico de red vía conectores:** NAPs cercanas y puertos, métricas de red, eventos de nodo, **dispositivos LAN** y **dispositivos WiFi**, y **configuración WiFi con GET *y PUT*** (vía conector **ACS/TR-069**), tareas insatisfactorias y visitas previas.
- **Datos del cliente:** perfil (GET/PUT) y estado de contrato (vía `comarch`).
- **Plataforma:** auth JWT + bcrypt, RBAC base (usuario del token sobrescribe `technicianId`), media S3/MinIO, paginación, manejo de errores tipado, 67 pruebas Vitest, contrato OpenAPI.

**Implicación directa:** el módulo Asistencia Técnica **no reimplementa el escaneo WiFi ni los dispositivos del LAN** — los consume. La "lista de dispositivos conectados" de Wifi Monitor ya es `GET /accounts/{n}/lan-devices` + `/wifi-devices`. El estudio WiFi se compone de las herramientas existentes.

---

## 6. La brecha: qué debe aportar Asistencia Técnica

Lo que **no** está en la app nueva y constituye el módulo:

1. **Ciclo de vida de la sesión de asistencia** (técnico solicita → cola del Call Center → agente toma → en vivo → resuelto/cerrado), con auditoría.
2. **Señalización en tiempo real** técnico ↔ Call Center (reemplazo formal del socket.io ad-hoc).
3. **Acciones sobre el equipo** (reinicio, cambio de SSID/clave, canal, reaprovisionamiento, diagnóstico) — vía **ACS/TR-069**, extendiendo el conector que ya existe.
4. **Sesión remota segura** que reemplaza el `iframe`+`localtunnel` público.
5. **Video/voz** (reemplazo/modernización de Jitsi).
6. **Auto-asistencia**: motor que corre el estudio + telemetría y propone/aplica remediaciones.
7. **Portal del Call Center moderno** (no existe aún en la app nueva).
8. **Conectores de operadora faltantes**: ticketing, órdenes FSM, retiro anticipado, agendamiento de turnos y **telemetría de planta (ONU/cablemodem)** — el catálogo de Proxy Xtrim es la especificación.

---

## 7. Arquitectura recomendada (lo más nuevo, sobre el stack congelado)

### 7.1 Principio: reconstruir, no portar
Los repos legados son **fuente de especificación**, no base de código. Se reconstruye sobre Fastify 5 / Prisma 5 / PG, reutilizando los patrones ya presentes (módulos, conectores, Zod, JWT, auditoría).

### 7.2 Dos planos de "tocar el equipo"
- **Plano de control (preferente): ACS / TR-069** y, donde el parque lo soporte, **TR-369 / USP**. La mayoría de las soluciones (reiniciar, SSID/clave, canal, reaprovisionar) deben ir por aquí: estándar, atraviesa NAT (el CPE inicia), seguro y auditable. **Ya hay conector ACS con `updateWifiConfig`** — se extiende con `reboot`, `setChannel`, `factoryReset`, `reprovision`, `runDiagnostic` (ping/traceroute TR-143).
- **Plano de sesión en vivo (excepción): sesión remota segura** para cuando el agente deba "manejar" el panel del router o copilotar al técnico en equipos sin ACS. Reemplaza al túnel público (7.4).

### 7.3 Señalización y ciclo de vida
Un **gateway WebSocket en el mismo backend Fastify** (p. ej. `@fastify/websocket`) en vez de un socket.io separado, autenticado con el mismo JWT. Encima, una **máquina de estados** explícita de la sesión:

```
REQUESTED → QUEUED → ASSIGNED → ACTIVE → (ON_HOLD ⇄ ACTIVE)
ACTIVE → RESOLVED | UNRESOLVED | CANCELLED | EXPIRED
```

Cada transición y cada acción quedan registradas como eventos (timeline + auditoría).

### 7.4 Reemplazo del túnel `localtunnel`
Tres opciones, en orden de preferencia:
1. **ACS primero**: si el equipo habla TR-069, no se abre túnel — se actúa por el plano de control. Cubre la mayoría de casos.
2. **Sesión remota intermediada (broker)**: la app del técnico (Capacitor) abre un **WebSocket saliente** a un *relay* de Wifix; el agente alcanza el panel del router **solo a través del portal autenticado**, con sesión **de corta duración, con alcance a ese CPE, registrada y opcionalmente grabada**. Nada de subdominios públicos ni HTTP.
3. **Co-browsing / asistencia guiada**: en lugar de exponer el router, el agente ve la sesión del técnico y le indica acciones; el técnico ejecuta. Menor superficie de ataque.

### 7.5 Video/voz (WebRTC)
Reemplazar el Jitsi self-host antiguo por **Jitsi moderno self-host** (control y costo) **o un SFU gestionado** (LiveKit/Daily, menos operación). Decisión de costo/operación en sección 10.

### 7.6 Auto-asistencia
Formalizar `wifix-autoassistance` como un **motor de reglas/diagnóstico**: corre el estudio WiFi + telemetría de planta (conector ISP/ONU) → detecta causas (señal baja, SNR malo, canal saturado, ONU con RxPower fuera de rango) → **propone** y, con consentimiento, **aplica** remediaciones vía ACS. Auditable y reversible.

### 7.7 Conectores de operadora a añadir (mapa desde Proxy Xtrim)
Incorporar como **conectores nuevos** (mock→real) en la capa existente, no como un proxy aparte:

| Capacidad | Servicio Xtrim | Conector destino |
|-----------|----------------|------------------|
| Ticketing | `GeneraTicket`/`ObtieneTicket`/`...BackOffice` | nuevo `ticketing` |
| Órdenes FSM | `FsmOrdenes`/`CreaFsmVistec`/`FsmOrdenCancelacion`/`FlujoPendiente` | extender `fsm` |
| Retiro anticipado | `RetiroAnticipado` | `ticketing`/`fsm` |
| Agendamiento | `Get/Create/CierraTurnoCliente` | nuevo `scheduling` |
| Telemetría planta | `OnuRxPower`/`networksnr`/`cablemodem*` | extender `ispmonitor` |
| Cuenta/facturas | `buscarCuentas`/`ObtieneFacturas`/propiedades | mapear a `comarch` |

> **Recomendación sobre Proxy Xtrim:** su único valor propio era **auth + logging**. Eso lo replican la capa de conectores + una tabla `ConnectorCallLog`. Sugiero **plegar Proxy Xtrim dentro del backend** como conectores y retirar el servicio NestJS separado (menos superficie, un solo punto de auth/secretos/auditoría).

### 7.8 Portal del Call Center moderno
No existe aún; hay que construirlo. Como es una herramienta de escritorio rica (no la app móvil del técnico), recomiendo **React + TypeScript + Vite** (o Next.js si se quiere SSR), consumiendo la **misma API Fastify + el WebSocket**. Vistas:
- **Cola de solicitudes** de asistencia (en vivo, por prioridad/zona).
- **Visor del estudio WiFi** (mapa de calor, speedtest, pings, dispositivos).
- **Consola de sesión en vivo**: video + acciones de equipo (ACS) + sesión remota segura.
- **Tickets / órdenes FSM / agendamiento** integrados.
- **Auditoría** y, si se habilita, reproducción de sesión.

### 7.9 Seguridad y cumplimiento (de primera clase)
- **HTTPS/WSS** en todo; cero exposición pública del router.
- **RBAC**: técnico / agente / supervisor; **autorización por sesión a un CPE concreto**.
- **Auditoría completa** (quién hizo qué sobre qué cuenta y cuándo) + **consentimiento del cliente** capturado + **sesiones acotadas en tiempo**.
- Secretos solo en backend (Hetzner/Dokploy + secretos); ningún token en el cliente ni en el código.

---

## 8. Modelo de datos propuesto (Prisma) para Asistencia Técnica

Propuesta (para revisión), respetando las convenciones del esquema actual (uuid `@db.Uuid`, `snake_case` con `@map`, `Timestamptz(6)`, vínculo por `accountNumber`/`visitId`). **Reutiliza** las tablas de herramientas existentes; no las duplica.

```prisma
enum AssistanceStatus {
  REQUESTED
  QUEUED
  ASSIGNED
  ACTIVE
  ON_HOLD
  RESOLVED
  UNRESOLVED
  CANCELLED
  EXPIRED
  @@map("assistance_status")
}

model AssistanceSession {
  id             String           @id @default(uuid()) @db.Uuid
  accountNumber  String           @map("account_number")
  visitId        String?          @map("visit_id")
  technicianId   String?          @map("technician_id")   // del JWT
  agentId        String?          @map("agent_id")        // agente del Call Center
  status         AssistanceStatus @default(REQUESTED)
  reason         String?
  consentAt      DateTime?        @map("consent_at") @db.Timestamptz(6)
  requestedAt    DateTime         @default(now()) @map("requested_at") @db.Timestamptz(6)
  closedAt       DateTime?        @map("closed_at") @db.Timestamptz(6)
  resolutionNote String?          @map("resolution_note")

  events         AssistanceEvent[]
  remoteActions  RemoteAction[]
  remoteSessions RemoteSession[]

  @@index([accountNumber])
  @@index([status])
  @@index([requestedAt])
  @@map("assistance_sessions")
}

model AssistanceEvent {     // timeline + auditoría de la sesión
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id") @db.Uuid
  type        String                                   // STATE_CHANGE, MESSAGE, ACTION, NOTE...
  payload     Json?
  actorId     String?  @map("actor_id")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  session AssistanceSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId])
  @@map("assistance_events")
}

model RemoteAction {        // acción sobre el equipo (vía ACS/TR-069)
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id") @db.Uuid
  accountNumber String @map("account_number")
  action      String                                   // REBOOT, SET_WIFI, SET_CHANNEL, FACTORY_RESET, REPROVISION, RUN_DIAGNOSTIC
  status      String   @default("PENDING")             // PENDING, SUCCESS, FAILED
  request     Json?
  result      Json?
  performedBy String?  @map("performed_by")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  session AssistanceSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId])
  @@index([accountNumber])
  @@map("remote_actions")
}

model RemoteSession {       // canal en vivo (broker/cobrowse/webrtc) — reemplaza localtunnel
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id") @db.Uuid
  channel     String                                   // ACS, BROKER_TUNNEL, COBROWSE, WEBRTC
  status      String   @default("OPEN")                // OPEN, CLOSED, EXPIRED
  expiresAt   DateTime @map("expires_at") @db.Timestamptz(6)
  recordingId String?  @map("recording_id") @db.Uuid   // -> MediaFile
  startedAt   DateTime @default(now()) @map("started_at") @db.Timestamptz(6)
  endedAt     DateTime? @map("ended_at") @db.Timestamptz(6)

  session AssistanceSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId])
  @@map("remote_sessions")
}

model ConnectorCallLog {    // reemplaza proxy_logs de Proxy Xtrim
  id           String   @id @default(uuid()) @db.Uuid
  connector    String                                  // comarch, fsm, ispmonitor, acs, ticketing, scheduling...
  operation    String
  accountNumber String? @map("account_number")
  status       Int?
  request      Json?
  response     Json?
  durationMs   Int?     @map("duration_ms")
  actorId      String?  @map("actor_id")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([connector])
  @@index([accountNumber])
  @@index([createdAt])
  @@map("connector_call_logs")
}
```

---

## 9. Plan por fases (con checkpoints)

Cada fase termina con tu confirmación explícita antes de avanzar. Decisiones de stack congeladas salvo aprobación previa.

| Fase | Entregable | Skills aplicables | Checkpoint |
|------|-----------|-------------------|------------|
| **A** | Contrato de API + modelo de datos de Asistencia (máquina de estados, eventos, acciones, logs). ADR de las decisiones clave. | `contrato-api`, `adr`, `esquema-prisma` | Apruebas contrato y modelo |
| **B** | Gateway WebSocket en Fastify + ciclo de vida (solicitud → cola → asignación → en vivo → cierre) con mock. | `pruebas`, `revision-codigo` | Apruebas el flujo |
| **C** | Acciones de equipo vía **ACS** (reboot, wifi-config, canal, reaprovisionar, diagnóstico), extendiendo el conector existente. | `pruebas`, `revision-codigo` | Apruebas acciones |
| **D** | Sesión remota segura (reemplazo de `localtunnel`) + WebRTC. | `adr`, `revision-codigo` | Apruebas enfoque y seguridad |
| **E** | Portal del Call Center nuevo (cola, visor de estudio, consola en vivo, auditoría). | `revision-a11y`, `revision-codigo` | Apruebas portal |
| **F** | Auto-asistencia (motor de diagnóstico/remediación) + conectores de operadora (ticketing/FSM/turnos/telemetría) y retiro de Proxy Xtrim. | `pruebas`, `revision-codigo` | Apruebas y cierre |

---

## 10. Decisiones que necesito de ti antes de construir

1. **Cobertura TR-069 del parque y rol del "manejo del router":** ¿qué porcentaje de equipos instalados habla **ACS/TR-069** hoy, y cuánto de la asistencia *requiere realmente* que el agente opere el panel web del router (vs. resolverlo con acciones ACS)? Esto decide si el plano de sesión remota (7.4) es central o un fallback menor.
2. **Estrategia de sesión remota:** ¿broker seguro (el agente "maneja" el router de forma intermediada) o **co-browsing** (el agente guía y el técnico ejecuta)? Impacta seguridad y esfuerzo.
3. **WebRTC:** **Jitsi self-host moderno** (más control/menor costo recurrente, más operación) o **SFU gestionado** (LiveKit/Daily; menos operación, costo por uso).
4. **Stack del portal del Call Center:** propongo **React + TypeScript + Vite**. ¿Lo confirmas o prefieres Next.js / Angular moderno?
5. **Proxy Xtrim:** ¿lo **plegamos** dentro del backend como conectores (mi recomendación) o lo mantienes como servicio separado?
6. **Backend "mirror" de Wifi Monitor (Next.js 15 + Prisma 6):** ¿fue un experimento o quieres consolidar esos datos dentro del backend de Wifix?

Con tus respuestas (sobre todo 1, 2 y 4) arranco la **Fase A**: contrato de API + modelo de datos de Asistencia Técnica.
