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
| `comarch` | TYTAN / Comarch CM | 4, 5 (plan/velocidad) | mock |
| `fsm` | FSM (`fsm-data-ms`) | 1, 2, 3, 6, 7, 8, 15, 16 | **real, sin token** |
| `ispmonitor` | ISP Monitor (tec-api) | 9, 10, 11, 12 | **real** |
| `acs` | ACS (TR-069) | 19, 20, 21 | mock |
| `tec` | TEC / registro GPON | 6, 8 (respaldo) | **real** |
| `rms` | RMS | 14 | mock |

`CONNECTOR_MODE_FSM` controla FSM aparte. Se despliega en `mock` hasta que haya
un token vigente de la operadora: en `mock` todas las rutas devuelven los shapes
completos del contrato, así que el frontend se construye y se prueba sin token.

### API de operadora (TEC / ISP Monitor)

`src/connectors/http/` implementa el acceso a `tec-api.grupotvcable.com`:

- `digest.ts` — autenticación HTTP Digest (RFC 2617, `qop="auth"`). El
  challenge se cachea por origen, así que solo la primera petición paga la
  vuelta extra del 401. La operadora confirmó que **el nonce cambia día a
  día**, no por petición: cuando rota, el 401 ya trae el challenge nuevo y se
  re-firma con él sin gastar otra vuelta. Si varias peticiones arrancan en
  frío a la vez, comparten una sola negociación.
- `throttle.ts` — dedupe de peticiones idénticas en vuelo, cache con TTL corto
  (`TEC_API_CACHE_TTL_MS`, 60 s por defecto) y semáforo de concurrencia
  (`TEC_API_MAX_CONCURRENCY`, 4). Ver *Cuidado del upstream*.
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
| `network/online/{id}` | `terminalsOnline` | cuántos equipos de la misma red de acceso están en línea — **no** es un 0/1 |
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
204 y la serie viene vacía, así que `/diagnostics` directamente no las
consulta. Un ONT de fibra tampoco se encuentra por su MAC (verificado): para
fibra va el GPON SN, la MAC es para cablemódems HFC.

### Respuestas de la operadora (2026-08-27)

Contestaron las siete dudas abiertas. Lo que cambia en el código:

| Pregunta | Respuesta | Efecto |
|----------|-----------|--------|
| ¿El nonce del Digest es fijo? | **Cambia día a día.** | El cache de challenge se mantiene; al rotar, se adopta el challenge del propio 401 sin renegociar aparte. |
| ¿Hay tope de peticiones? | **No hay límite, pero "el sistema no tiene recursos infinitos": no consultar todos los datos sin definir cuándo hacen falta".** | Dedupe + cache corto + semáforo, y `/diagnostics` pide solo lo que aplica. |
| ¿Qué son `drop`, `device`, `ifIndex`, `index`? | **Solo `drop` es relevante:** informa si el monitoreo detectó una caída de red. | `drop` pasa a campo propio del snapshot; los otros tres salen de `fields` (siguen en `raw`). |
| `network/online` devolvió 18 / 12: ¿son equipos del nodo? ¿Cómo saco el %? | **No existe el concepto de nodo.** Los datos salen de tarjetas de CMTS (HFC — un ramal, un nodo o una combinación) o de puertos de OLT (GPON — un hilo de fibra). | Se habla de **red de acceso**, no de nodo, y se muestra la **cantidad** de equipos en línea: sin el total de la red, un porcentaje no se puede calcular. |
| ¿La ventana de las series es siempre 24 h? | **Sí, las últimas 24 h al momento de la consulta.** | `TerminalDiagnostics.window`; el % de disponibilidad se pondera por tiempo, porque la cantidad de muestras varía (122–292). |
| ¿Decos, decos HD y MTA usan los mismos endpoints? | **No disponen de esa información.** | La guía de la app deja de prometerlo; se puede probar, pero "sin datos" no es un bug. |
| ¿Hay ambiente de pruebas? | **Sistema en producción.** | No se corren pruebas de carga ni se automatiza nada contra la API real. |

**Pendiente con la operadora:** identificadores de equipos (aunque sean de
cuentas de prueba) con evento activo en la red, con caídas en las últimas
24 h, y un cablemódem con FEC sin corregir > 0, para validar los casos de
alerta de la app.

### Cuidado del upstream

No hay ambiente de pruebas: **toda consulta golpea producción**. Tres piezas
sostienen el pedido de la operadora de no consultar de más:

1. **Consultar solo lo que aplica.** `/terminals/{id}/diagnostics` pide primero
   la ficha y, según la tecnología que devuelva, las series: en GPON las cuatro
   series DOCSIS no se piden (3 llamadas upstream en vez de 7) y con un id que
   la operadora no conoce no se pide ninguna (1 en vez de 7). Lo omitido viaja
   en `skipped`, con el motivo, para que la app lo explique en pantalla.
2. **Dedupe y cache corto** (`throttle.ts`): dos consultas simultáneas del mismo
   equipo son una sola petición, y repetir la consulta dentro de
   `TEC_API_CACHE_TTL_MS` (60 s) no vuelve a salir a la red. Las series se
   refrescan cada 5 minutos: repetir antes devuelve lo mismo. Los errores no se
   cachean.
3. **Semáforo de concurrencia** (`TEC_API_MAX_CONCURRENCY`, 4): con varios
   técnicos en campo, las peticiones hacen cola en vez de salir en ráfaga.

`scripts/probe-tec-api.ts` es manual y de a un equipo: no lo pongas en un
bucle ni en CI.

Para sondear la API a mano:

```bash
npx tsx scripts/probe-tec-api.ts naps -2.1685829163 -79.9189910889
npx tsx scripts/probe-tec-api.ts all <SERIAL_O_MAC>
```

**Faltantes conocidos con los accesos actuales:** el tráfico de internet del
cliente (campo 13). El detalle puerto a puerto por NAP (campo 8) ya no depende
de TEC: lo resuelve FSM (`/naps/accounts`); por el camino TEC `getNapPorts`
sigue devolviendo `detailAvailable: false` con una nota, en vez de fallar.

## Conector FSM (`fsm-data-ms`)

`https://apix.grupotvcable.com/rest/fsm-data-api/v1.0` — órdenes de trabajo,
tareas, notas, NAPs GPON y estado de cuenta. Habilita los campos 1-3, 6, 7, 8,
15 y 16.

| Endpoint upstream | Uso | Ruta interna |
|-------------------|-----|--------------|
| `POST /account/process` | órdenes + identidad del cliente | `client-profile`, `contract-status`, `orders`, `previous-visits`, `unsatisfactory-tasks` |
| `POST /workorder/tasks` | tareas y notas de una orden | `workorders/tasks`, `unsatisfactory-tasks` |
| `POST /account/status` | estado A/S/T/O/P de una cuenta | `contract-status`, `accounts/status-batch` |
| `GET /naps/nearest` | NAPs cercanas (campo 6) | `naps/nearby` |
| `GET /naps/accounts` | cuentas/equipos de una NAP (campo 8) | `naps/{napRef}/ports` |

Capas: `routes` → `connectors/fsm/index.ts` (modelo interno, mock \| real) →
`connectors/http/fsm-api.ts` (HTTP + caudal) → `connectors/http/fsm-token.ts`
(Bearer). **Ninguna ruta importa `http/fsm-api.ts` directamente.**
`connectors/fsm/normalize.ts` aísla todo el mapeo crudo → interno.

### Marca (realm), no "realm"

Hay dos realms de Keycloak, uno por marca comercial. Internamente se habla de
**`brand`** (`telenews` \| `seteinfo`) y los nombres `realm-ecommerce-callcenter-*`
quedan encerrados en `fsm-token.ts`: el técnico nunca los ve. La marca viaja en
el header **`X-Wifix-Brand`**, con override por query `?brand=`; si falta se usa
`FSM_DEFAULT_BRAND`.

### El token vence cada 24 h — y eso NO puede tumbar la app

- **Un 401 de FSM jamás sale como 401 del backend.** La webapp borra la sesión
  del técnico ante cualquier 401: un token caducado de un tercero lo sacaría al
  login en medio de una visita y encima le quitaría Herramientas y Equipos
  Retirados, que no dependen de FSM. Se traduce a **503 `UPSTREAM_AUTH_ERROR`**
  con `meta.reason` ∈ `MISSING` \| `EXPIRED` \| `REJECTED`.
- **Chequeo previo sin red:** `fsm-token.ts` decodifica el `exp` del JWT
  (base64, sin verificar firma) y corta antes de salir a la red si ya venció.
- **El servidor arranca igual sin token** (solo `console.warn`), a diferencia de
  TEC, cuyas credenciales Digest sí son obligatorias.
- Los tokens **nunca** se loguean: en logs solo `brand`, `azp` y `exp`.

Prioridad de resolución: `client_credentials`
(`FSM_TOKEN_URL_*` + `FSM_CLIENT_ID_*` + `FSM_CLIENT_SECRET_*`, con
single-flight y refresh en `exp − FSM_TOKEN_SKEW_MS`) → token estático
`FSM_API_TOKEN_<MARCA>` → `MISSING`.

⚠ El emisor del token de ejemplo es `192.168.59.181:8080` (IP privada): si ese
Keycloak solo vive en la LAN de la operadora, `client_credentials` no funcionará
desde el servidor y **la rotación manual es el camino real**, no el de respaldo.

**Rotación manual del token (procedimiento):**

1. Pedir el Bearer nuevo al contacto de la operadora (dura 24 h).
2. Pegarlo en `FSM_API_TOKEN_TELENEWS` (o `..._SETEINFO`) del `.env` del
   servidor. No se comparte por canales sin cifrar y no se commitea.
3. Reiniciar el servicio (el token se lee del entorno al arrancar).
4. Verificar **sin gastar una consulta a producción**:
   `npx tsx scripts/probe-fsm-api.ts token` o `GET /integrations/fsm/health`,
   que informan `expiresAt` y `expiresInSeconds` de cada marca.

### Cuidado del upstream en FSM

Mismas tres piezas que TEC, con **semáforo propio** (`FSM_API_MAX_CONCURRENCY`,
4) porque es otro host, y con dos reglas extra:

- **Prefijo de cache obligatorio `FSM:{brand}:`.** El cache de `throttle.ts` es
  un `Map` global compartido con TEC: sin el prefijo de marca, una cuenta
  consultada en `telenews` devolvería el resultado cacheado a `seteinfo`. Es
  una fuga entre realms, no un detalle de estilo. Hay un test que lo verifica.
- **El fan-out del campo 8 es explícito y en lote.** `GET /naps/{napRef}/ports`
  hace **1 sola llamada** y devuelve los puertos con `clientStatus: null` y
  `statusPending: true`; los estados los pide el técnico a mano con
  `POST /accounts/status-batch` (≤12 cuentas, concurrencia 4, cache 5 min).
  Resolver una NAP de 16 puertos "completa" costaría 17 llamadas por cada tap
  en "Ver puertos".

Llamadas upstream por ruta:

| Ruta interna | Llamadas |
|--------------|----------|
| `GET /integrations/fsm/health` | **0** |
| `GET /accounts/{n}/client-profile` | 1 |
| `GET /accounts/{n}/contract-status` | 2 |
| `GET /accounts/{n}/orders` | 1 |
| `GET /accounts/{n}/previous-visits` | 1 |
| `GET /accounts/{n}/unsatisfactory-tasks` | 1 + ≤ `FSM_ORDERS_MAX_FANOUT` |
| `GET /workorders/tasks?workOrder=` | 1 |
| `GET /naps/nearby` | 1 |
| `GET /naps/{napRef}/ports` | 1 |
| `POST /accounts/status-batch` | ≤ `FSM_STATUS_BATCH_LIMIT` |

### Fuente de NAPs (campo 6)

`NAPS_PRIMARY_SOURCE` (`fsm` \| `tec`) decide quién sirve `/naps/nearby`. **Hoy
se despliega en `tec`**, que es lo que ya funciona en producción; se cambia a
`fsm` el día que haya token. Con `fsm`, si falla la autenticación se cae a TEC y
se responde 200 con `source:"TEC"` más un aviso en el header
`X-Wifix-Degraded`. Si FSM falla por otra causa (5xx, timeout) **no** hay
fallback: se propaga el 502, porque un error transitorio no justifica duplicar
la carga sobre la otra API.

### Sondeo manual: `probe-fsm-api.ts`

Es la **única** vía de contacto manual con FSM y es de un solo tiro: no lo
pongas en un bucle ni en CI. `chain` está acotado a 4 llamadas.

```bash
npx tsx scripts/probe-fsm-api.ts token                    # sin red: brand, azp, exp, tiempo restante
npx tsx scripts/probe-fsm-api.ts process <cuenta> [Todas|Pendientes]
npx tsx scripts/probe-fsm-api.ts tasks <workOrder>
npx tsx scripts/probe-fsm-api.ts status <cuenta>          # prueba account_id y, si falla, accountId
npx tsx scripts/probe-fsm-api.ts naps <lat> <lng> [meters] [maxRows]
npx tsx scripts/probe-fsm-api.ts nap-accounts <napId>
npx tsx scripts/probe-fsm-api.ts chain <cuenta>           # máx. 4 llamadas
# flags: --brand=telenews|seteinfo   --save (guarda el JSON en tests/fixtures/fsm/)
```

### Lo que todavía es un supuesto

No hay **ni una** respuesta real de FSM: todos los parsers de `normalize.ts`
están escritos contra la documentación y la colección de Postman, con mapeo
tolerante (`pick()` multi-clave). Antes de dar por buena la integración hay que
correr `probe-fsm-api.ts --save` con un token vigente y recalibrar. En
particular:

- **`classifyTaskResult()` es un heurístico.** La doc no enumera los valores de
  `status` de `/workorder/tasks` ni expone un campo satisfactoria/insatisfactoria:
  se infiere de `status` + notas con `FSM_UNSATISFACTORY_KEYWORDS`.
- **`/account/status`: `account_id` o `accountId`.** La doc dice una cosa y el
  Postman otra. El conector manda `account_id`, ante un 400 reintenta **una** vez
  con `accountId` y memoiza cuál funcionó.
- **`ClosedTask.technician` no existe en FSM**: siempre `null`.
- **La rejilla de puertos** necesita el total de puertos de `/naps/nearest`. Si
  no se conoce, se devuelven solo los puertos ocupados con
  `degraded.reason: TRUNCATED`.

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
| Diagnóstico de Red | `/herramientas/v1/naps/nearby?lat=&lng=&meters=&maxRows=` | GET |
| | `/herramientas/v1/naps/{napRef}/ports` | GET |
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
| | `/herramientas/v1/accounts/{n}/orders` | GET |
| | `/herramientas/v1/workorders/tasks?workOrder=` | GET |
| Integraciones | `/herramientas/v1/integrations/fsm/health` | GET |
| | `/herramientas/v1/accounts/status-batch` | POST |

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
| `UPSTREAM_AUTH_ERROR` | 503 | Token de FSM ausente, vencido o rechazado |
| `INTERNAL_ERROR` | 500 | Error no controlado |

`UNAUTHORIZED` (401) es **solo** para el JWT propio de Wifix: ningún fallo de
FSM puede producir un 401, porque la webapp cierra la sesión del técnico ante
cualquiera. `UPSTREAM_AUTH_ERROR` trae un bloque `meta` con
`{ integration, brand, reason, tokenExpiresAt, retryable }`; el cliente pinta un
banner no bloqueante y **no** cierra sesión.

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
│   ├── http/       # digest · tec-api · fsm-token · fsm-api · throttle
│   └── naps.ts     # política FSM/TEC del campo 6 (ADR-04)
└── modules/
    ├── auth/                 # POST /auth/login, GET /auth/me
    ├── catalogs/
    ├── media/
    ├── tools/{distance,speedtest,heatmap,ping,traceroute}/
    ├── retired-equipment/
    ├── account-history/
    ├── client-data/          # campos 1-5, 7 (compone fsm + comarch)
    ├── network-diagnostics/  # 6, 8-14, 19-21 (varios conectores)
    ├── tasks-visits/         # campos 15-16 y órdenes (usa fsm)
    └── integrations/         # salud de FSM y estados en lote
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
- `CONNECTOR_MODE_TEC`, `CONNECTOR_MODE_ISPMONITOR`, `CONNECTOR_MODE_FSM` —
  override por conector.
- `TEC_API_BASE_URL`, `TEC_API_USERNAME`, `TEC_API_PASSWORD`,
  `TEC_API_TIMEOUT_MS` — API de operadora (Digest). Obligatorias si alguno
  de esos dos conectores está en `real`; el arranque aborta si faltan.
- `TEC_API_MAX_CONCURRENCY` (4), `TEC_API_CACHE_TTL_MS` (60000) — cuidado del
  upstream: peticiones simultáneas máximas y vigencia del cache de respuestas.
- `FSM_API_BASE_URL`, `FSM_API_CHANNEL`, `FSM_API_TIMEOUT_MS` — API de FSM.
  **No abortan el arranque si faltan credenciales**, a diferencia de TEC.
- `FSM_API_TOKEN_TELENEWS` / `FSM_API_TOKEN_SETEINFO` — Bearer estático (24 h).
  Alternativa: `FSM_TOKEN_URL_*` + `FSM_CLIENT_ID_*` + `FSM_CLIENT_SECRET_*`
  (`client_credentials`, con prioridad) y `FSM_TOKEN_SKEW_MS` (60000).
- `FSM_BRANDS`, `FSM_DEFAULT_BRAND`, `FSM_BRAND_STRATEGY` — marcas/realms.
- `FSM_API_MAX_CONCURRENCY` (4), `FSM_API_CACHE_TTL_MS` (60000),
  `FSM_STATUS_CACHE_TTL_MS` (300000), `FSM_STATUS_BATCH_LIMIT` (12),
  `FSM_ORDERS_MAX_FANOUT` (5) — cuidado del upstream en FSM.
- `FSM_UNSATISFACTORY_KEYWORDS` — heurístico de clasificación del campo 15.
- `NAPS_PRIMARY_SOURCE` (`fsm` | `tec`) — fuente del campo 6.
- `DATABASE_URL` — Postgres (puerto 5433 con el `docker-compose.yml` actual).
- `STORAGE_*` — MinIO/S3.

## Pruebas

```bash
docker compose up -d
npm run prisma:migrate && npm run prisma:seed
npm test
```

Los tests de FSM y de los conectores **no necesitan Postgres ni MinIO** y
**nunca** salen a la red: usan `tests/helpers/fsm-app.ts`, que levanta la app sin
base de datos y reemplaza `fetch` por un doble que además cuenta las llamadas.
Todo es producción del lado de la operadora: ninguna prueba puede pegarle.

```bash
npx vitest run tests/connectors tests/lib tests/middleware   # sin infraestructura
```

**Cobertura actual:** 162 pruebas en 18 archivos:

- `lib/`: paginación (9), validación (3)
- `middleware/`: error handler (6)
- `connectors/`: determinismo y persistencia de PUT mock (8), Digest y parseo
  de TEC/ISP Monitor (33), token de FSM (17), cliente HTTP de FSM (15),
  normalización de FSM (22), throttle (9)
- `modules/`: auth (7), catalogs (4), media (4), tools (7), retired-equipment (5),
  account-history (2), integration-endpoints (12), rutas de FSM (31)

## Paso a conectores reales

Para activar el modo real:

1. Cambiar `CONNECTOR_MODE=real` en `.env`, o solo el conector que
   corresponda (`CONNECTOR_MODE_TEC`, `CONNECTOR_MODE_ISPMONITOR`,
   `CONNECTOR_MODE_FSM`).
2. Implementar cada `*Real` en `src/connectors/<system>/index.ts` reemplazando
   los `notImplemented(...)` por llamadas HTTP a la API del sistema.
3. Agregar las URLs y credenciales por sistema como variables de entorno
   nuevas (una por conector).

`tec`, `ispmonitor` y `fsm` ya siguen este patrón: sirven de referencia para los
que faltan.

**Para encender FSM** hacen falta dos pasos más, en este orden:

1. `CONNECTOR_MODE_FSM=real` + `FSM_API_TOKEN_TELENEWS=<bearer vigente>`, y
   verificar con `npx tsx scripts/probe-fsm-api.ts token`.
2. Recalibrar `connectors/fsm/normalize.ts` con respuestas reales
   (`probe-fsm-api.ts <comando> --save`). Hasta entonces los parsers están
   escritos a ciegas contra la documentación.
3. Recién después, `NAPS_PRIMARY_SOURCE=fsm` para migrar el campo 6 de TEC a
   FSM (el panel NAP ya está en producción con TEC: no se toca hasta tener
   datos reales verificados).

Los módulos de routes y los tests **no requieren cambios** — el cambio se
concentra en la capa de conectores.
