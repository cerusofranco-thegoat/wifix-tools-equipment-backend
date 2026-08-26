# Wifix Certificate — Backend de la app (Fase 2)

Backend de la app Wifix Certificate completa. Persiste los datos que la app genera
(Herramientas y Equipos Retirados, campos 22-27) e **integra** los datos
de los sistemas de la operadora (campos 1-21) mediante una capa de
conectores que en esta etapa funciona con **datos simulados (mock)**.

La API es la del contrato
[`../openapi-herramientas-equipos.yaml`](../openapi-herramientas-equipos.yaml).

## Stack

- Node.js 20 LTS · TypeScript (`strict`, ESM)
- Fastify 5 · Zod · Prisma 5 · PostgreSQL 15
- Autenticación: JWT HS256 (`jose`) + `bcrypt`
- Almacenamiento S3-compatible (`@aws-sdk/client-s3`; MinIO en local)
- pino (logging) · Vitest + light-my-request (pruebas)
- ESLint v9 (flat config) · Prettier

## Requisitos

- Node.js 20 LTS o superior
- Docker + Docker Compose (PostgreSQL y MinIO en local)

## Puesta en marcha

```bash
# 1. Instalar dependencias
npm install

# 2. Variables de entorno
cp .env.example .env

# 3. Levantar PostgreSQL y MinIO
docker compose up -d

# 4. Aplicar migraciones y sembrar catálogos + usuario inicial
npm run prisma:migrate
npm run prisma:seed

# 5. Iniciar el servidor en modo desarrollo
npm run dev
```

El servidor escucha en `http://localhost:8080`. La API del contrato se
sirve bajo el prefijo `/herramientas/v1`. PostgreSQL queda expuesto en
el puerto **5433** (evita choque con otros postgres locales).

### Verificación rápida

```bash
# /health no exige token
curl http://localhost:8080/health

# El resto pide Authorization: Bearer <jwt>
TOKEN=$(curl -s -X POST http://localhost:8080/herramientas/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"franco@tulpasolutions.com","password":"wifix-dev-2026"}' | jq -r .token)

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/herramientas/v1/catalogs/equipment-models | head
```

## Autenticación

- `POST /auth/login` recibe `{ email, password }`, valida contra la tabla
  `users` con bcrypt y devuelve `{ token, user }` (JWT HS256 firmado con
  `JWT_SECRET`, vigencia `JWT_EXPIRES_IN`).
- `GET /auth/me` devuelve el usuario del token.
- Un middleware `onRequest` valida el `Authorization: Bearer` en todos los
  endpoints **excepto** `/health` (raíz + API) y `/auth/login`. Token
  ausente, inválido o expirado → 401 `UNAUTHORIZED`.
- Usuario inicial sembrado por `prisma/seed.ts`:
  `SEED_USER_EMAIL` con la contraseña de `SEED_USER_PASSWORD` (hasheada
  con bcrypt cost 10).
- Los POST de Herramientas y Equipos Retirados **sobreescriben**
  `technicianId` con el `user.id` del JWT autenticado, ignorando lo que
  venga en el cuerpo (resuelve el origen del campo `technicianId`).

## Capa de conectores (sistemas externos, datos campos 1-21)

`src/connectors/` aísla cada sistema externo en su propio módulo. Cada
conector define una **interfaz** y dos implementaciones:

- **Mock** — datos simulados deterministas por clave (xmur3 + mulberry32
  semillado por `accountNumber` o `napCode`). Las escrituras (`PUT
  client-profile`, `PUT wifi-config`) guardan un override en memoria del
  proceso para que GET → PUT → GET sean coherentes durante una sesión.
- **Real** — implementación contra la API del operador. `tec` e `ispmonitor`
  ya están implementados; el resto sigue siendo esqueleto que lanza
  `CONNECTOR_ERROR` (502) hasta que entreguen credenciales y URLs.

`CONNECTOR_MODE=mock|real` fija el modo global; `CONNECTOR_MODE_TEC` y
`CONNECTOR_MODE_ISPMONITOR` lo sobreescriben por conector, que es lo que
permite tener TEC e ISP Monitor en real y el resto en mock.

| Conector | Sistema real | Campos | Estado |
|----------|--------------|--------|--------|
| `comarch` | TYTAN / Comarch CM | 1, 2, 3, 4, 5, 7 | mock |
| `fsm` | FSM | 15, 16 | mock |
| `ispmonitor` | ISP Monitor (tec-api) | 9, 10, 11, 12 | **real** |
| `acs` | ACS (TR-069) | 19, 20, 21 | mock |
| `tec` | TEC / registro GPON | 6, 8 (parcial) | **real** |
| `rms` | RMS | 14 | mock |

### API de operadora (TEC / ISP Monitor)

`src/connectors/http/` implementa el acceso a `tec-api.grupotvcable.com`:

- `digest.ts` — autenticación HTTP Digest (RFC 2617, `qop="auth"`). El
  challenge se cachea por origen, así que solo la primera petición paga la
  vuelta extra del 401; si el servidor rota el nonce se renegocia solo.
- `tec-api.ts` — un método por endpoint, más `normalizeTerminalId()`
  (normaliza MAC con separadores a hex plano: IIS rechaza los `:` en la ruta).
  Un 204/404 del upstream se traduce a `null` — es la respuesta normal para
  un id que no existe, no un error.
- `ispmonitor/normalize.ts` — normalización tolerante de las series de 24 h.
  La API no publica esquema, así que se detectan en runtime la clave temporal
  (`date`/`fecha`/`timestamp`/`/Date(ms)/`…) y las claves numéricas. Si el
  formato no se reconoce, `recognized: false` y el payload original viaja en
  `raw`.

| Endpoint upstream | Uso |
|-------------------|-----|
| `GET /api/tec/naps/{lat},{lng}` | NAPs cercanas (campo 6) |
| `GET /api/isp/terminals/{id}` | Estado equipo/red + evento |
| `GET /api/isp/status/{id}` | Estado del terminal, 24 h |
| `GET /api/isp/network/online/{id}` | Estado de la red, 24 h |
| `GET /api/isp/cablemodem/snr/{id}` | SNR del terminal, 24 h (campo 10) |
| `GET /api/isp/network/snr/{id}` | SNR de la red, 24 h |
| `GET /api/isp/cablemodem/codewords/{id}` | FEC del terminal, 24 h (campo 11) |
| `GET /api/isp/network/codewords/{id}` | FEC de la red, 24 h |

### Shapes verificados contra la API real (2026-08-26)

`GET /api/isp/terminals/{id}` devuelve un objeto plano:

```json
{ "type": "GPON", "city": "Quito", "id": "ZTEGD3F9BBE5", "device": 9919,
  "ifIndex": 285282307, "index": 11, "networks": [9198], "status": "up",
  "drop": null, "events": null,
  "terminals": [ { "Type": "LastMonth", "IDs": ["ZTEGD0BB8294"],
                   "Status": ["down"], "Drop": "", "Events": "" } ] }
```

Las series de 24 h son **tuplas `[[epochSegundos, valor], …]`**, 288 muestras
(una cada 5 minutos), sin nombres de columna. El conector se los pone:

| Endpoint | Clave | Significado |
|----------|-------|-------------|
| `status/{id}` | `online` | 1 en línea, 0 caído |
| `network/online/{id}` | `terminalsOnline` | cuántos equipos del nodo están en línea — **no** es un 0/1 |
| `*/snr/{id}` | `snr` o `snrDown`/`snrUp` | según cuántas columnas traiga |
| `*/codewords/{id}` | `errors` o `corrected`/`uncorrected` | ídem |

Las métricas DOCSIS llegan además **desglosadas por canal upstream**: la
respuesta es un array de canales, cada uno con su propia serie en `data`.

```json
[ { "ifIndex": 5000018, "network": "2G-2 v",
    "desc": "Logical Upstream Channel 0/1.1/0",
    "data": [[1787772828, 35.6], [1787773128, 35.6]] }, … ]
```

`normalizeSeries` los expone en `channels[]`; `keys`/`points` reflejan el
primer canal para consumidores que no los manejen.

Códigos de respuesta del upstream:

- **400 `{"Message":"Invalid serial number"}`** — el id no tiene forma de serial
  GPON (4 letras + 8 caracteres) ni de MAC (12 hex). El backend lo traduce a
  `VALIDATION_ERROR` (400), no a error de conector. El **D-SN** y el **EN**
  impresos en la etiqueta de un ONT ZTE caen acá: hay que usar el **GPON SN**.
- **204** — formato válido pero el equipo no está en ISP Monitor (sin
  aprovisionar). Se traduce a `found: false`, no a error.

SNR y codewords son métricas **DOCSIS**: en equipos GPON la operadora responde
204 y la serie viene vacía. Un ONT de fibra tampoco se encuentra por su MAC
(verificado): para fibra va el GPON SN, la MAC es para cablemódems HFC.

Para sondear la API a mano:

```bash
npx tsx scripts/probe-tec-api.ts naps -2.1685829163 -79.9189910889
npx tsx scripts/probe-tec-api.ts all <SERIAL_O_MAC>
```

**Faltantes conocidos con los accesos actuales:** el detalle puerto a puerto
por NAP (campo 8 — clientes A/S, vive en `tec.grupotvcable.com/Gpon/Coverage`)
y el tráfico de internet del cliente (campo 13). `getNapPorts` real devuelve
`detailAvailable: false` con una nota, en vez de fallar.

## Endpoints

| Grupo | Endpoint | Método |
|-------|----------|--------|
| Health | `/health` · `/herramientas/v1/health` | GET |
| Auth | `/herramientas/v1/auth/login` | POST |
| | `/herramientas/v1/auth/me` | GET |
| Catálogos | `/herramientas/v1/catalogs/equipment-models` | GET |
| | `/herramientas/v1/catalogs/removal-reasons` | GET |
| | `/herramientas/v1/catalogs/speedtest-servers` | GET |
| | `/herramientas/v1/catalogs/network-servers` | GET |
| Herramientas — Distancia | `/herramientas/v1/distance-measurements[/{id}]` | POST · GET |
| Herramientas — Speedtest | `/herramientas/v1/speedtests[/{id}]` | POST · GET |
| Herramientas — Mapa de calor | `/herramientas/v1/wifi-heatmaps[/{id}]` | POST · GET |
| Herramientas — Ping | `/herramientas/v1/ping-tests[/{id}]` | POST · GET |
| Herramientas — Traceroute | `/herramientas/v1/traceroute-tests[/{id}]` | POST · GET |
| Equipos retirados | `/herramientas/v1/retired-equipment[/{id}]` | POST · GET |
| Media | `/herramientas/v1/media` (multipart) | POST |
| | `/herramientas/v1/media/{id}` | GET |
| Historial | `/herramientas/v1/accounts/{accountNumber}/tool-history` | GET |
| Datos del Cliente | `/herramientas/v1/accounts/{n}/client-profile` | GET · PUT |
| | `/herramientas/v1/accounts/{n}/contract-status` | GET |
| Diagnóstico de Red | `/herramientas/v1/naps/nearby?lat=&lng=` | GET |
| | `/herramientas/v1/naps/{napCode}/ports` | GET |
| | `/herramientas/v1/terminals/{id}` | GET |
| | `/herramientas/v1/terminals/{id}/diagnostics` | GET |
| | `/herramientas/v1/terminals/{id}/series/{scope}/{metric}` | GET |
| | `/herramientas/v1/accounts/{n}/network-metrics` | GET |
| | `/herramientas/v1/accounts/{n}/node-events` | GET |
| | `/herramientas/v1/accounts/{n}/lan-devices` | GET |
| | `/herramientas/v1/accounts/{n}/wifi-devices` | GET |
| | `/herramientas/v1/accounts/{n}/wifi-config` | GET · PUT |
| Tareas y Visitas | `/herramientas/v1/accounts/{n}/unsatisfactory-tasks` | GET |
| | `/herramientas/v1/accounts/{n}/previous-visits` | GET |

## Reglas de negocio (resumen)

- `accountNumber` es **obligatorio** en cada POST transaccional.
- `measuredAt`/`retiredAt` no pueden ser fechas futuras (tolerancia 5 min).
- Paginación: `page ≥ 1`, `pageSize` 1..100 (default 20).
- **Speedtest:** `downloadMbps`, `uploadMbps` obligatorios y ≥ 0.
- **Mapa de calor:** al menos 1 habitación; `signalDbm` ∈ [-120, 0]; `floor` default 1.
- **Ping:** si se envían ambos, `packetsReceived ≤ packetsSent`; `heatmapId` debe existir.
- **Equipos retirados:** `equipmentModelId` y `removalReasonCode` deben existir en
  catálogo; `serialFieldType` se copia del modelo al crear; `barcodePhotoId` debe existir.
- **`PUT client-profile` y `PUT wifi-config`** registran en el log el `user.id`
  del JWT, `accountNumber` y los campos editados.
- **Mock determinista:** las consultas de los conectores devuelven los mismos
  datos para una misma `accountNumber` / `napCode`.

## Códigos de error

| Código | HTTP | Uso |
|--------|------|-----|
| `VALIDATION_ERROR` | 400 | Cuerpo o parámetros inválidos |
| `UNAUTHORIZED` | 401 | Token/credenciales inválidos |
| `NOT_FOUND` | 404 | Recurso transaccional inexistente |
| `CATALOG_ITEM_NOT_FOUND` | 404 | Modelo o motivo de catálogo inexistente |
| `MEDIA_NOT_FOUND` | 404 | `barcodePhotoId` inexistente |
| `CONNECTOR_ERROR` | 502 | Fallo de un sistema externo (modo real) |
| `INTERNAL_ERROR` | 500 | Error no controlado |

Mensajes (`message`) en español; códigos en inglés.

## Scripts

| Script | Descripción |
|--------|-------------|
| `npm run dev` | Servidor con recarga en caliente (tsx). |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm start` | Arranca el servidor compilado. |
| `npm run lint` / `npm run lint:fix` | ESLint (flat config). |
| `npm run format` | Prettier. |
| `npm test` | Corre la suite Vitest (requiere Postgres y MinIO arriba). |
| `npm run test:watch` | Vitest en modo watch. |
| `npm run prisma:generate` | Regenera el cliente Prisma. |
| `npm run prisma:migrate` | Aplica migraciones de Prisma. |
| `npm run prisma:seed` | Siembra usuario + catálogos (idempotente). |

## Estructura del código

```
src/
├── config/         # validación de variables de entorno
├── db/             # cliente Prisma compartido
├── auth/           # firmado/verificación de JWT (jose)
├── middleware/     # error handler global, authenticate (Bearer)
├── lib/            # storage S3, paginación, validación Zod, helpers
├── schemas/        # service-context, filters, geo, common (UUID)
├── connectors/     # comarch · fsm · ispmonitor · acs · tec · rms
└── modules/
    ├── auth/                 # POST /auth/login, GET /auth/me
    ├── catalogs/
    ├── media/
    ├── tools/{distance,speedtest,heatmap,ping,traceroute}/
    ├── retired-equipment/
    ├── account-history/
    ├── client-data/          # campos 1-5, 7 (usa comarch)
    ├── network-diagnostics/  # 6, 8-14, 19-21 (varios conectores)
    └── tasks-visits/         # campos 15-16 (usa fsm)
```

## Almacenamiento de archivos

`POST /media` recibe `multipart/form-data`, sube a un bucket S3-compatible
y devuelve `{ id, url, contentType, sizeBytes, createdAt }`.

- En desarrollo: **MinIO** vía Docker Compose (bucket `wifix-media` con
  acceso público de lectura creado automáticamente).
- En producción: AWS S3 u otro compatible (cambiar `STORAGE_*` en env).
- Tipos permitidos: `image/jpeg`, `image/png`. Tamaño máximo: 10 MB.

## Variables de entorno

Ver `.env.example`. Validadas con Zod al arrancar; si alguna es inválida
el proceso aborta con un mensaje claro. Las relevantes:

- `JWT_SECRET`, `JWT_EXPIRES_IN` — emisión y vigencia del token.
- `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`, `SEED_USER_NAME` — usuario inicial.
- `CONNECTOR_MODE` — `mock` o `real` (modo global de los conectores).
- `CONNECTOR_MODE_TEC`, `CONNECTOR_MODE_ISPMONITOR` — override por conector.
- `TEC_API_BASE_URL`, `TEC_API_USERNAME`, `TEC_API_PASSWORD`,
  `TEC_API_TIMEOUT_MS` — API de operadora (Digest). Obligatorias si alguno
  de esos dos conectores está en `real`; el arranque aborta si faltan.
- `DATABASE_URL` — Postgres (puerto 5433 con el `docker-compose.yml` actual).
- `STORAGE_*` — MinIO/S3.

## Pruebas

```bash
docker compose up -d
npm run prisma:migrate && npm run prisma:seed
npm test
```

**Cobertura actual:** 67 pruebas en 11 archivos:

- `lib/`: paginación (9), validación (3)
- `middleware/`: error handler (6)
- `connectors/`: determinismo y persistencia de PUT mock (8)
- `modules/`: auth (7), catalogs (4), media (4), tools (7), retired-equipment (5),
  account-history (2), integration-endpoints (12)

## Paso a conectores reales

Para activar el modo real:

1. Cambiar `CONNECTOR_MODE=real` en `.env`, o solo el conector que
   corresponda (`CONNECTOR_MODE_TEC`, `CONNECTOR_MODE_ISPMONITOR`).
2. Implementar cada `*Real` en `src/connectors/<system>/index.ts` reemplazando
   los `notImplemented(...)` por llamadas HTTP a la API del sistema.
3. Agregar las URLs y credenciales por sistema como variables de entorno
   nuevas (una por conector).

`tec` e `ispmonitor` ya siguen este patrón: sirven de referencia para los
que faltan.

Los módulos de routes y los tests **no requieren cambios** — el cambio se
concentra en la capa de conectores.
