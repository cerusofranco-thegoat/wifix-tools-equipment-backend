# Wifix — Backend de Herramientas y Equipos Retirados

Servicio backend de la **Fase 1** del módulo de Herramientas y Equipos
Retirados de la app Wifix. Persiste resultados de mediciones de campo y
registros de equipos retirados, y expone la API descrita en
[`../openapi-herramientas-equipos.yaml`](../openapi-herramientas-equipos.yaml).

## Stack

- Node.js 20 LTS · TypeScript (`strict`, ESM)
- Fastify 5 · Zod · Prisma 5 · PostgreSQL 15
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

# 4. Aplicar migraciones y sembrar catálogos
npm run prisma:migrate
npm run prisma:seed

# 5. Iniciar el servidor en modo desarrollo
npm run dev
```

El servidor escucha en `http://localhost:8080`. La API del contrato se
sirve bajo el prefijo `/herramientas/v1`.

### Verificación rápida

```bash
curl http://localhost:8080/health
curl http://localhost:8080/herramientas/v1/catalogs/equipment-models | head
```

## Endpoints

| Grupo | Endpoint | Método |
|-------|----------|--------|
| Health | `/health` · `/herramientas/v1/health` | GET |
| Catálogos | `/herramientas/v1/catalogs/equipment-models` | GET |
| | `/herramientas/v1/catalogs/removal-reasons` | GET |
| | `/herramientas/v1/catalogs/speedtest-servers` | GET |
| | `/herramientas/v1/catalogs/network-servers` | GET |
| Distancia | `/herramientas/v1/distance-measurements` | POST · GET (lista) |
| | `/herramientas/v1/distance-measurements/{id}` | GET |
| Speedtest | `/herramientas/v1/speedtests` | POST · GET |
| | `/herramientas/v1/speedtests/{id}` | GET |
| Mapa de calor | `/herramientas/v1/wifi-heatmaps` | POST · GET |
| | `/herramientas/v1/wifi-heatmaps/{id}` | GET |
| Ping | `/herramientas/v1/ping-tests` | POST · GET |
| | `/herramientas/v1/ping-tests/{id}` | GET |
| Traceroute | `/herramientas/v1/traceroute-tests` | POST · GET |
| | `/herramientas/v1/traceroute-tests/{id}` | GET |
| Equipos retirados | `/herramientas/v1/retired-equipment` | POST · GET |
| | `/herramientas/v1/retired-equipment/{id}` | GET |
| Media | `/herramientas/v1/media` (multipart) | POST |
| | `/herramientas/v1/media/{id}` | GET |
| Historial | `/herramientas/v1/accounts/{accountNumber}/tool-history` | GET |

## Reglas de negocio (resumen)

Implementadas en los servicios, ver SPEC.md §10:

- `accountNumber` es **obligatorio** en cada POST transaccional (clave de Fase 1).
- `measuredAt`/`retiredAt` no pueden ser fechas futuras (tolerancia 5 min).
- Paginación: `page ≥ 1`, `pageSize` 1..100 (default 20).
- **Speedtest:** `downloadMbps`, `uploadMbps` obligatorios y ≥ 0.
- **Mapa de calor:** al menos 1 habitación; `signalDbm` ∈ [-120, 0]; `floor` default 1.
- **Ping:** si se envían ambos, `packetsReceived ≤ packetsSent`; `heatmapId` debe existir.
- **Equipos retirados:** `equipmentModelId` y `removalReasonCode` deben existir en
  catálogo (`CATALOG_ITEM_NOT_FOUND`); `serialFieldType` se copia del modelo al
  crear el registro; `barcodePhotoId` debe existir (`MEDIA_NOT_FOUND`).

## Códigos de error (esquema `Error` del OpenAPI)

| Código | HTTP | Uso |
|--------|------|-----|
| `VALIDATION_ERROR` | 400 | Cuerpo o parámetros inválidos |
| `NOT_FOUND` | 404 | Recurso transaccional inexistente |
| `CATALOG_ITEM_NOT_FOUND` | 404 | Modelo o motivo de catálogo inexistente |
| `MEDIA_NOT_FOUND` | 404 | `barcodePhotoId` inexistente |
| `INTERNAL_ERROR` | 500 | Error no controlado |

Mensajes (`message`) en español; códigos en inglés.

## Scripts

| Script | Descripción |
|--------|-------------|
| `npm run dev` | Arranca el servidor con recarga en caliente (tsx). |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm start` | Arranca el servidor compilado. |
| `npm run lint` / `npm run lint:fix` | ESLint (flat config). |
| `npm run format` | Prettier. |
| `npm test` | Corre la suite Vitest (requiere Postgres y MinIO arriba). |
| `npm run test:watch` | Vitest en modo watch. |
| `npm run prisma:generate` | Regenera el cliente Prisma. |
| `npm run prisma:migrate` | Aplica migraciones de Prisma. |
| `npm run prisma:seed` | Siembra los catálogos (idempotente). |

## Estructura del código

Cada módulo de negocio se organiza en capas `routes → service → repository`
(SPEC.md §6). Resumen:

```
src/
├── config/        # validación de variables de entorno
├── db/            # cliente Prisma compartido
├── middleware/    # error handler global con esquema Error
├── lib/           # storage S3-compatible, paginación, validación Zod, helpers
├── schemas/       # service-context, filters, geo, common (UUID)
└── modules/
    ├── catalogs/
    ├── media/
    ├── tools/{distance,speedtest,heatmap,ping,traceroute}/
    ├── retired-equipment/
    └── account-history/
```

## Autenticación

**La Fase 1 no tiene autenticación.** Los endpoints son abiertos. El código
está estructurado de modo que un middleware de auth (JWT u otro) pueda
agregarse más adelante sin reescribir los módulos.

## Almacenamiento de archivos

`POST /media` recibe `multipart/form-data`, sube a un bucket S3-compatible
y devuelve `{ id, url, contentType, sizeBytes, createdAt }`.

- En desarrollo se usa **MinIO** vía Docker Compose (`docker-compose.yml`
  crea automáticamente el bucket `wifix-media` con acceso público de lectura).
- En producción AWS S3 u otro compatible (cambiar `STORAGE_*` en env).
- Tipos permitidos: `image/jpeg`, `image/png`. Tamaño máximo: 10 MB.

## Variables de entorno

Ver `.env.example`. Todas son validadas con Zod al arrancar; si falta o es
inválida alguna, el proceso aborta con un mensaje claro.

## Pruebas

```bash
# Asegurar Postgres + MinIO arriba con catálogos sembrados
docker compose up -d
npm run prisma:migrate && npm run prisma:seed

npm test
```

**Cobertura actual:** 40 pruebas en 8 archivos cubriendo paginación,
validación, error handler, los 4 catálogos, media (upload/retrieval),
las 5 herramientas (flujo + validaciones), equipos retirados (incluyendo
ambos códigos 404) e historial agregado de la cuenta.
