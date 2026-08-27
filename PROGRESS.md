# PROGRESS — App Wifix Certificate (Fase 1 + Fase 2)

Registro de avance por fase del proyecto. Se actualiza al cerrar cada
fase. Las casillas marcadas indican entregables verificados.

**Fase 1** (2026-05-24): módulo Herramientas + Equipos Retirados, sin auth.
**Fase 2** (2026-05-26): re-scope a la app completa con login + JWT + capa
de conectores hacia 6 sistemas externos (modo mock) + endpoints de
integración campos 1-21 + tres pantallas nuevas en el frontend.

---

## PARTE A — Backend (`./backend`)

### Fase A0 — Andamiaje · ✅ Completada (2026-05-24)
- [x] `package.json`, `tsconfig.json` (strict), ESLint y Prettier.
- [x] Estructura de carpetas según SPEC.md §6.
- [x] Fastify + pino + CORS + manejador de errores global.
- [x] `GET /health` (raíz) y `GET /herramientas/v1/health`.
- [x] `docker-compose.yml` con PostgreSQL 15 + MinIO (y bucket init).
- [x] `.env.example` con las variables de SPEC.md §14.
- **Verificación:** `npm install && docker compose up -d && npm run dev`,
  luego `curl http://localhost:8080/health` debe responder 200.

### Fase A1 — Modelo de datos (Prisma) · ✅ Completada (2026-05-24)
- [x] `prisma/schema.prisma` con 13 modelos (4 catálogos + 8 transaccionales + media),
      4 enums con `@map` para preservar guiones del contrato, mapeos snake_case
      ↔ camelCase e índices sobre `account_number`, `client_id`, `visit_id`,
      `measured_at`/`retired_at` y `serial_value`.
- [x] Migración inicial `20260524231509_init` generada y aplicada.
- [x] `prisma/seed.ts` idempotente con los datos de SPEC §8: 10 equipment_models,
      8 removal_reasons, 2 speedtest_servers ejemplo, 5 network_servers ejemplo.
- [x] Cliente Prisma generado; `src/db/prisma.ts` expone instancia compartida.
- **Verificación:** `docker compose up -d postgres && npm run prisma:migrate &&
  npm run prisma:seed` corre sin error; segunda corrida del seed mantiene los
  mismos conteos (idempotente).

### Fase A2 — Middleware base (Zod + paginación) · ✅ Completada (2026-05-24)
- [x] `src/lib/validation.ts`: `parseBody/parseQuery/parseParams` convierten
      `ZodError` en `ApiError(VALIDATION_ERROR)` con `details[].field/issue`.
- [x] `src/lib/pagination.ts`: `paginationSchema` (defaults SPEC §10: page≥1,
      pageSize 1..100 default 20), `toSkipTake`, `toPageInfo`, `toPagedResponse`.
- [x] `src/lib/datetime.ts`: helper para validar `measuredAt`/`retiredAt` no
      futuras con tolerancia de 5 min (SPEC §10).
- [x] Error handler refinado: captura `ZodError` no envuelto y produce el
      mismo formato `Error` del OpenAPI.
- [x] Vitest configurado; ESLint v9 (flat config) limpio.
- [x] 18 pruebas: validación, paginación, e integración del handler
      verificando que una ruta de prueba responde con el esquema `Error`.
- **Verificación:** `npm test` → 18/18 ✓. `npm run lint` → sin errores.

### Fase A3 — Catálogos · ✅ Completada (2026-05-24)
- [x] 4 endpoints GET bajo `/herramientas/v1/catalogs/*`.
- [x] Capas `repository → service → routes` + mappers Prisma→DTO.
- [x] Traducción `HOST_SN → HOST-SN` (y demás guiones) en serialFieldType.
- [x] `location` en speedtest-servers solo cuando hay coordenadas.
- [x] 4 pruebas de integración contra Postgres real.

### Fase A4 — Media · ✅ Completada (2026-05-24)
- [x] `src/lib/storage.ts` — adaptador S3-compatible (`@aws-sdk/client-s3`,
      `forcePathStyle` para MinIO). `uploadObject` y `objectExists`.
- [x] Módulo media: routes/service/repository/mappers.
- [x] `POST /media` (multipart) valida tipo (jpeg/png) y tamaño (10 MB).
- [x] `GET /media/{id}` con UUID validado.
- [x] 4 pruebas de integración contra MinIO + Postgres.

### Fase A5 — Herramientas · ✅ Completada (2026-05-24)
- [x] Schemas/utilidades compartidas: `service-context` (ServiceContext con
      `accountNumber` obligatorio), `filters` (listFiltersSchema +
      buildContextWhere/buildDateRangeWhere), `geo` (geoPointSchema +
      toGeoPoint), `not-future` (helper measuredAt no futuro).
- [x] **Distancia** — POST/GET lista/GET por id; GeoPoint opcional.
- [x] **Speedtest** — download/upload obligatorios y >= 0.
- [x] **Mapa de calor WiFi** — al menos 1 habitación, signalDbm -120..0,
      floor default 1.
- [x] **Ping** — packetsReceived <= packetsSent; heatmapId valida existencia.
- [x] **Traceroute** — hops nested con `host` y `latencyMs` nullable
      (salto sin respuesta), devueltos ordenados por hopNumber.
- [x] `parseOrThrow` refactor a `S extends ZodTypeAny` para preservar
      el tipo de salida de schemas con `.default()`.
- [x] 7 pruebas integradas: éxito, validaciones, filtros y casos de error.

### Fase A6 — Equipos retirados · ✅ Completada (2026-05-24)
- [x] POST/GET lista filtrada/GET por id de `/retired-equipment`.
- [x] Filtros adicionales: `removalReasonCode`, `serialValue` (contains
      insensitive).
- [x] Valida `equipmentModelId` y `removalReasonCode` contra catálogo
      (`CATALOG_ITEM_NOT_FOUND`); valida `barcodePhotoId` (`MEDIA_NOT_FOUND`).
- [x] Copia `serialFieldType` como snapshot del modelo al crear el registro.
- [x] `barcodePhotoUrl` resuelto desde la relación con `media_files`.
- [x] 5 pruebas integradas cubriendo flujos y todos los códigos de error.

### Fase A7 — Historial de la cuenta · ✅ Completada (2026-05-24)
- [x] `GET /accounts/{accountNumber}/tool-history` agrega en paralelo los
      6 tipos de registro asociados a la cuenta (distance, speedtest,
      heatmap, ping, traceroute, retired-equipment).
- [x] Filtro opcional por rango de fecha (`dateFrom`/`dateTo`) aplicado
      según el campo natural de cada tipo (measuredAt/createdAt/retiredAt).
- [x] 2 pruebas integradas: cuenta con los 6 tipos + filtro de fecha.

### Fase A8 — Pruebas y cierre del backend · ✅ Completada (2026-05-24)
- [x] **40 pruebas en 8 archivos** (todas verdes):
      pagination (9), validation (3), error-handler (6), catalogs (4),
      media (4), tools (7), retired-equipment (5), account-history (2).
- [x] `npm run build` produce `dist/` sin errores.
- [x] `npm run lint` limpio.
- [x] `README.md` completo: stack, puesta en marcha, endpoints, reglas
      de negocio, códigos de error, scripts, estructura, almacenamiento,
      variables de entorno y guía de pruebas.
- [x] Criterios de aceptación de backend (SPEC §18) cumplidos.

---

## PARTE B — Frontend (en `wifix-webapp`)

### Fases B0–B4 · ✅ Completadas (2026-05-24)
- [x] **B0 — Estudio del repo:** identificados patrones a reutilizar:
      `.detailscreen` con `.open`/`aria-hidden`; `.sub-header + .back-btn`;
      `.account-chip`; acordeón estilo `SERVICIO_ITEMS` (head/body/chev);
      tokens de diseño (cyan `#00e0ff`, status `#00ff9d`/`#ff5a5a`);
      `data-sub="herramientas"` ya existía pero sin handler.
- [x] **B1 — `api.js` (nuevo):** capa de consumo con `API_BASE_URL`,
      una función por endpoint del contrato y modo mock por defecto
      (toggle `WifixAPI.useRealApi = true` para fetch real). Rellena
      `clientId`/`visitId`/`technicianId` con valores de prueba.
- [x] **B2 — Pantalla de Herramientas:** sub-card `herramientas` ahora
      abre `#detailHerramientas` con acordeón de las 5 herramientas
      (formularios manuales por la nota técnica SPEC §15, disclaimer
      visible). Habitaciones del heatmap y saltos de traceroute son
      filas dinámicas con +/× para agregar y eliminar.
- [x] **B3 — Pantalla de Equipos Retirados:** nueva sub-card en
      `.sub-grid` que abre `#detailRetirados`. Formulario carga modelos
      y motivos desde `api.js`, sube foto del código de barras vía
      `WifixAPI.uploadMedia` y guarda con `createRetiredEquipment`.
- [x] **B4 — Estilos:** bloque nuevo al final de `styles.css` siguiendo
      la nomenclatura existente; no toca estilos previos.
- [x] Trabajo en rama `feature/tools-and-retired-equipment`.
- [x] Sintaxis JS verificada con `node --check`; servidor estático en
      `npx http-server . -p 5173` sirve los 3 archivos sin error.

---

## PARTE C — Integración · ✅ Completada (2026-05-24)
- [x] Backend levantado en `http://localhost:8080` (compilado a `dist/`,
      ejecutado con `node dist/src/server.js`).
- [x] Frontend `api.js` ya estructurado para alternar mock/real con
      `WifixAPI.useRealApi = true` (un único punto de cambio).
- [x] **Flujo end-to-end verificado** (los 6 POSTs respondieron 201,
      el historial agregado devuelve los 6 registros de la cuenta):
      - distance-measurements: HTTP 201
      - speedtests: HTTP 201
      - wifi-heatmaps: HTTP 201
      - ping-tests: HTTP 201
      - traceroute-tests: HTTP 201
      - retired-equipment: HTTP 201
      - `GET /accounts/{accountNumber}/tool-history` → 6 registros

---

# Fase 2 — App Wifix completa

Re-scope a la app completa: login + JWT, capa de conectores hacia los
sistemas externos en modo mock, endpoints de integración (campos 1-21)
y pantallas nuevas en el frontend. **El OpenAPI ya cubre los 33
endpoints** (auth + catálogos + herramientas + retiros + media + historial
+ datos cliente + diagnóstico + tareas/visitas) — no se tocó el contrato.

## PARTE A2 — Backend

### Fase A1δ — Tabla users · ✅ Completada (2026-05-26)
- [x] Modelo `User` (id uuid, email único, passwordHash, name, active,
      createdAt) en `prisma/schema.prisma`.
- [x] Migración `20260526210008_add_users` aplicada.
- [x] `prisma/seed.ts` siembra usuario inicial `franco@tulpasolutions.com`
      con bcrypt cost 10. Variables: `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`,
      `SEED_USER_NAME`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `CONNECTOR_MODE`.
- [x] Puerto Postgres cambia de 5432 → 5433 (evita choque con otros
      contenedores locales).
- **Verificación:** `npm run prisma:migrate && npm run prisma:seed` corre
  sin error; segunda corrida mantiene los conteos (idempotente).

### Fase A2 — Autenticación · ✅ Completada (2026-05-26)
- [x] `POST /auth/login` (bcrypt + jose HS256), `GET /auth/me`.
- [x] Middleware `onRequest` valida `Authorization: Bearer` en todos los
      endpoints salvo `/health` (raíz + API) y `/auth/login`.
- [x] Códigos de error nuevos: `UNAUTHORIZED` (401), `CONNECTOR_ERROR` (502).
- [x] **Decisión pendiente #1 resuelta:** los POST de herramientas y
      equipos retirados sobreescriben `technicianId = request.authUser.id`,
      ignorando lo que venga en el cuerpo. `clientId`/`visitId` siguen
      como valores de prueba.
- [x] Tests: `tests/helpers/test-app.ts` devuelve `{ app, authHeaders }`
      con un usuario test y token fresco; los 7 tests previos se actualizaron;
      `tests/modules/auth.test.ts` nuevo con 7 tests (login OK / inválido /
      validación email; /me; sin token; firma inválida; /health sin token).
- **Verificación:** 47/47 tests verdes tras la fase.

### Fase A9 — Capa de conectores (mock + esqueleto real) · ✅ Completada (2026-05-26)
- [x] `src/connectors/_shared.ts` con PRNG seeded (xmur3 + mulberry32) y
      helper `notImplemented(operation)`.
- [x] Seis conectores en `src/connectors/{comarch,fsm,ispmonitor,acs,tec,rms}/`,
      cada uno con interfaz + `*Mock` determinista por accountNumber/napCode
      + `*Real` esqueleto con TODO + factory `get<X>Connector()` que respeta
      `CONNECTOR_MODE`.
- [x] Datos mock en español, realistas (Ecuador): nombres, calles, planes
      Wifix Hogar/Business, NAPs `NAP-NN-NN-N`, dispositivos LAN/WiFi.
- [x] PUT en modo mock guarda override en memoria del proceso para que
      GET → PUT → GET sea coherente durante la sesión.
- [x] 8 tests verifican determinismo y persistencia in-memory de PUT.

### Fase A10 — Endpoints de integración campos 1-21 · ✅ Completada (2026-05-26)
- [x] **client-data** (módulo): `GET/PUT /accounts/{n}/client-profile`,
      `GET /accounts/{n}/contract-status`.
- [x] **network-diagnostics**: `nearby-naps`, `naps/{napCode}/ports`,
      `network-metrics`, `node-events`, `lan-devices`, `wifi-devices`,
      `GET/PUT wifi-config`. Validación Zod de `WifiConfigUpdate`
      (ssid 1-32, password 8-63, sin bandas duplicadas).
- [x] **tasks-visits**: `unsatisfactory-tasks`, `previous-visits`.
- [x] **13 endpoints** en total. Las escrituras (`PUT client-profile`,
      `PUT wifi-config`) registran en el log el `user.id` del JWT,
      `accountNumber` y los campos editados.
- [x] 12 tests de integración cubriendo cada endpoint, ambos PUT, y
      validación de inputs.

### Fase A11 — Cierre del backend · ✅ Completada (2026-05-26)
- [x] **67 tests en 11 archivos** (todas verdes):
      pagination (9), validation (3), error-handler (6), connectors (8),
      catalogs (4), auth (7), media (4), tools (7), retired-equipment (5),
      account-history (2), integration-endpoints (12).
- [x] `npm run build` y `npm run lint` limpios.
- [x] `README.md` reescrito: auth, conectores, 13 endpoints nuevos,
      códigos `UNAUTHORIZED` / `CONNECTOR_ERROR`, puerto 5433, guía para
      pasar a `CONNECTOR_MODE=real`.

---

## PARTE B2 — Frontend (`wifix-webapp`)

Trabajo en rama nueva **`feature/auth-and-client-data`** (no toca
`feature/tools-and-retired-equipment`).

### Fase B1δ — Login + token + api.js extendido · ✅ Completada (2026-05-26)
- [x] Pantalla de login como entrada de la app (sección `.loginscreen`
      con `.open` por default; se oculta tras autenticar; se reabre si
      el backend devuelve 401 vía evento `wifix:unauthorized`).
- [x] `api.js` guarda token + user en `localStorage` (`wifix_token`,
      `wifix_user`), lo envía en `Authorization: Bearer`, y al recibir
      401 limpia storage y dispara evento de sesión expirada.
- [x] Funciones nuevas: `login`, `logout`, `isAuthenticated`, `getMe`,
      `getClientProfile`, `updateClientProfile`, `getContractStatus`,
      `getNearbyNaps`, `getNapPorts`, `getNetworkMetrics`, `getNodeEvents`,
      `getLanDevices`, `getWifiDevices`, `getWifiConfig`,
      `updateWifiConfig`, `getUnsatisfactoryTasks`, `getPreviousVisits`.
- [x] Cada función tiene fallback mock por defecto y respeta
      `WifixAPI.useRealApi = true` para usar el backend real.
- [x] Header gana un botón de cerrar sesión (icono `logout`).

### Fase B2 — Datos Personales con PUT · ✅ Completada (2026-05-26)
- [x] `openDatosPersonales` reemplazado: ahora consulta
      `WifixAPI.getClientProfile(accountNumber)` y muestra los campos 1-5
      (nombres, dirección, teléfonos, plan, velocidad contratada).
- [x] Botón "Actualizar datos" abre formulario editable que llama a
      `PUT client-profile` (campo 4). Tras éxito, re-renderiza la vista
      con los nuevos datos.
- [x] Estados de carga / error (`detail-loading`, `detail-error`).

### Fase B3 — Datos del Servicio (campos 6-18) · ✅ Completada (2026-05-26)
- [x] Acordeón con 7 secciones que consumen el backend:
      NAPs cercanas (con botón "Ver puertos" que llama a
      `naps/{napCode}/ports`), status del cliente (`contract-status`),
      métricas de red (`network-metrics`), eventos del nodo
      (`node-events`), tareas insatisfactorias (`unsatisfactory-tasks`),
      visitas anteriores (`previous-visits`), historial de la app
      (`tool-history`).
- [x] Cada sección carga on-demand al abrirse y cachea el resultado.

### Fase B4 — Red Interna (campos 19-21 + PUT wifi-config) · ✅ Completada (2026-05-26)
- [x] Nueva pantalla `detailRed` (HTML) con acordeón de 3 secciones:
      equipos LAN (`lan-devices`), dispositivos WiFi por banda
      (`wifi-devices`), y formulario de cambio de SSID/contraseña.
- [x] El formulario muestra los SSID actuales por banda (2.4 GHz / 5 GHz),
      permite editar SSID y opcionalmente la contraseña, y llama a
      `PUT wifi-config`. Validación visual del minlength=8 en el password.

### Fase B5 — Estilos y cierre del frontend · ✅ Completada (2026-05-26)
- [x] Estilos nuevos al final de `styles.css` (sin tocar previos):
      `.loginscreen`, `.login-card`, `.login-form`, `.login-error`,
      `.save-btn.outline`, `.detail-loading/.detail-empty/.detail-error`,
      `.band-section`, `.band-title`, `.nap-ports-slot`, `.port-cell small`,
      `#logoutBtn`.
- [x] Sintaxis JS verificada con `node --check api.js && node --check app.js`.
- [x] `npx http-server . -p 5174` sirve la app sin error.

---

## PARTE C2 — Integración Fase 2 · ✅ Verificada (2026-05-26)

Backend levantado en `http://localhost:8080`, conectores en modo `mock`.
Endpoints probados con curl tras login real:

- `POST /auth/login` → HTTP 200, JWT emitido.
- `GET /accounts/WX-DEMO-001/client-profile` → 200 con datos mock
  determinista (Pedro Cevallos Aguilar, plan Wifix Hogar 400).
- `GET /accounts/WX-DEMO-001/wifi-config` → 200 con SSIDs por banda.
- `PUT /accounts/WX-DEMO-001/wifi-config` (cambia SSIDs) → 200, refleja
  el cambio.
- `PUT /accounts/WX-DEMO-001/client-profile` (cambia fullName + phones)
  → 200, refleja el cambio.
- `GET /accounts/WX-DEMO-001/unsatisfactory-tasks` → 200 con tareas
  cerradas como INSATISFACTORIA.
- Sin token: 401 `UNAUTHORIZED`.

Frontend con `WifixAPI.useRealApi = true` queda listo para hablar con
el backend; el flag se concentra en `api.js`.

## Decisiones pendientes (estado tras Fase 2)

| # | Tema | Estado |
|---|------|--------|
| 1 | Origen de `technicianId` | ✅ **Resuelto** — deriva de `user.id` del JWT en cada POST transaccional. |
| 2 | Marcas reales de equipos (brand null en seed) | Pendiente — sigue esperando respuesta del socio. |
| 3 | Servidores de speedtest/red reales | Pendiente — sembrados con ejemplos. |
| 4 | Ejecución nativa de ping/traceroute/dBm | Pendiente — webapp sigue captando por ingreso manual; Capacitor o app nativa es decisión posterior. |

## PARTE D — Wifix Certificate · APIs reales de operadora (2026-08-26)

**Renombre.** La app pasa a llamarse **Wifix Certificate**: `<title>`,
manifest PWA, `appName` de Capacitor, `app_name` de Android y los títulos de
SPEC/PROGRESS/README. El wordmark del header muestra `WIFIX` con
`Certificate` en el subtítulo. El `appId` (`com.tulpa.wifix`) **no** cambia:
cambiarlo rompería la actualización del APK ya instalado.

**Accesos conseguidos:** `tec-api.grupotvcable.com`, autenticación HTTP
Digest (realm `tec.grupotvcable.com`, `qop="auth"`). Verificado en vivo.

Implementado:

- `src/connectors/http/digest.ts` — cliente Digest RFC 2617 con cache de
  challenge por origen y renegociación si el nonce rota.
- `src/connectors/http/tec-api.ts` — los 8 endpoints de operadora, con
  normalización del id de terminal (MAC con `:` → hex plano; IIS rechaza
  los `:` en la ruta) y 204/404 → `null`.
- `src/connectors/ispmonitor/normalize.ts` — normalización tolerante de las
  series de 24 h: detecta en runtime la clave temporal y las numéricas.
- `tecReal` (campo 6) e `ispMonitorReal` (campos 9-12) sustituyen a los
  `notImplemented(...)`. Modo por conector: `CONNECTOR_MODE_TEC` y
  `CONNECTOR_MODE_ISPMONITOR` en `real`, el resto sigue en `mock`.
- Rutas nuevas: `GET /naps/nearby?lat=&lng=`, `GET /terminals/{id}`,
  `GET /terminals/{id}/diagnostics`, `GET /terminals/{id}/series/{scope}/{metric}`.
  El contrato OpenAPI se actualizó en el mismo commit.
- Frontend: el panel NAP consulta por coordenada real (GPS o manual) en vez
  de por número de cuenta; panel nuevo **ISP Monitor** en Datos del Servicio,
  con consulta por serial GPON / MAC (escaneable con ML Kit), badges de
  estado equipo/red/evento, barra de disponibilidad 24 h y gráficos SVG de
  SNR y FEC. Sin librerías de terceros.

Verificado: `GET /naps/nearby` devuelve 10 NAPs reales del sector de
Guayaquil consultado; validación de coordenadas y de `scope`/`metric`
responde 400; sin token, 401. `npx tsc`, `eslint` y las 26 pruebas de
conectores en verde; smoke de UI (`npm run smoke` en `wifix-webapp`) con 23
checks en verde.

### Calibración contra la API real (mismo día)

Con el ONT ZTE activo `ZTEGD3F9BBE5` (Quito, red de acceso 9198) se verificaron los
shapes y se ajustó el parseo:

- La ficha del terminal es un objeto plano con `type`/`city`/`status`/`events`
  más `terminals[]`, que es el **historial de equipos en ese puerto** por
  período (LastHour/Day/Week/Month). Se muestra en la app: le dice al técnico
  si el equipo anterior del domicilio venía cayéndose.
- Las series de 24 h son **tuplas `[[epoch, valor], …]`** — 288 muestras cada 5
  minutos. Se agregó ese caso al normalizador (antes solo cubría arrays de
  objetos y de escalares) y se corrigió que no ordenaba cronológicamente.
- `network/online` devuelve **cuántos equipos de la misma red de acceso están en línea** (18),
  no un 0/1. Se grafica como cantidad, no como barra de disponibilidad.
- SNR y codewords son **DOCSIS**: en GPON responden 204. La app lo explica en
  vez de dejar el hueco.
- La API distingue **400 `Invalid serial number`** (formato inválido) de **204**
  (formato válido, sin datos). El **D-SN** y el **EN** de la etiqueta de un ONT
  ZTE caen en el 400: va el **GPON SN**. El escáner de la app ahora descarta
  D-SN y EN y prioriza el GPON SN sobre la MAC, con una guía plegable de qué
  código corresponde a cada equipo (hoja *FOTOS SN EQUIPOS* del Excel).
- La barra de disponibilidad agrupa las 288 muestras en 48 celdas de 30 min;
  un tramo se marca caído si **cualquier** muestra suya lo estuvo.

Con el cablemódem HFC activo `384C90A2DB11` (Quito, red de acceso 168) se cerraron los
campos 10 y 11:

- SNR y codewords son **multicanal**: la respuesta es un array de canales
  upstream (`ifIndex` + `network` + `desc` + `data`), cada uno con su serie.
  Se agregó ese caso al normalizador (`channels[]`) y a `valueNamesFor`, que
  ahora cuenta las columnas dentro de `data`.
- En la app: SNR compara los dos canales en un solo gráfico (una línea por
  canal, que es la comparación que hace el técnico) y FEC usa un gráfico por
  canal, porque mezclar corregidos/sin corregir × N canales no se lee.
- El estado del cablemódem trajo 122 muestras y no 288: la cantidad varía
  según cuánto lleve el equipo en línea. El render no asume 288.

### Respuestas de la operadora y ajustes (2026-08-27)

La operadora contestó las siete dudas abiertas y confirmó que **los endpoints
entregados son los disponibles**. Lo que cambió en la app:

| Respuesta | Ajuste |
|-----------|--------|
| El **nonce del Digest cambia día a día**, no por petición. | Se mantiene el cache de challenge; cuando rota, el 401 ya trae el challenge nuevo y se re-firma con él (2 vueltas en vez de 3). Varias peticiones en frío comparten una sola negociación. |
| **No hay tope de peticiones**, pero pidieron no consultar de más: nada de "consultar todos los datos sin definir cuándo hacen falta". | `/diagnostics` pide primero la ficha y, según la tecnología, solo las series que aplican: **3 llamadas upstream en GPON** (antes 7) y **1** si el identificador no existe. Además, dedupe de peticiones en vuelo, cache de 60 s y semáforo de 4 peticiones simultáneas. |
| De la ficha, **solo `drop` es relevante**: dice si el monitoreo detectó una caída de red. `device`, `ifIndex` e `index` son internos. | `drop` pasa a campo propio y se muestra como alerta en la ficha; los otros tres desaparecen de la pantalla (siguen en `raw` para depurar). |
| **No existe el concepto de nodo.** Los datos salen de tarjetas de CMTS (HFC) o de puertos de OLT (GPON). Tampoco publican el total de la red. | En toda la app "nodo" pasa a **red de acceso**, con el nombre correcto según la tecnología (*Puerto de OLT (hilo de fibra)* / *Tarjeta de CMTS (ramal o nodo)*). El gráfico de red muestra la **cantidad** de equipos en línea y aclara que no es un porcentaje: sin el total, no se puede calcular. |
| Las series son **siempre las últimas 24 h al momento de la consulta**. | Se devuelve `window: { hours: 24, until }` y se dice en pantalla. El % de disponibilidad pasa a ponderarse **por tiempo** y no por muestra, porque la cantidad de muestras varía (122–292) y un promedio por muestra sesgaba el número. |
| **No disponen de información** sobre decos, decos HD y MTA. | La guía de códigos de la app deja de prometerlo: se puede probar con su SN/HOST-SN, pero "sin datos" no es un error de la app. |
| **Sistema en producción**, no hay ambiente de pruebas. | Nada automatizado contra la API real: las pruebas usan los payloads reales como fixtures y `probe-tec-api.ts` sigue siendo manual y de a un equipo. |

**Pendiente con la operadora:** identificadores de equipos (aunque sean de
cuentas de prueba) con evento activo en la red, con caídas en las últimas 24 h,
y un cablemódem con FEC sin corregir > 0, para validar los casos de alerta.

Verificado: `npx tsc`, `eslint` y **59 pruebas de conectores** en verde
(9 nuevas de dedupe/cache/semáforo y de rotación del nonce, 6 del plan de
consultas); smoke de UI con todos los checks en verde.

**Faltantes con los accesos actuales:** el detalle puerto a puerto por NAP
(campo 8, clientes A/S — vive en `tec.grupotvcable.com/Gpon/Coverage`, sin
API) y el tráfico de internet del cliente (campo 13). Ambos avisados en la
UI en vez de fallar.

## Paso siguiente: conectar APIs reales de la operadora

`CONNECTOR_MODE=real` activa el esqueleto; cada `*Real` en
`src/connectors/<system>/index.ts` reemplaza el `notImplemented(...)`
por llamadas HTTP a la API del sistema. Falta:

- URLs y credenciales por sistema (comarch, fsm, ispmonitor, acs, tec, rms).
- Mapeos de los DTOs externos a los del contrato OpenAPI.
- Tests adicionales contra los conectores reales en un entorno de QA.
