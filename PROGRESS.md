# PROGRESS — Módulo Herramientas y Equipos Retirados (Wifix)

Registro de avance por fase del proyecto. Se actualiza al cerrar cada
fase. Las casillas marcadas indican entregables verificados.

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
