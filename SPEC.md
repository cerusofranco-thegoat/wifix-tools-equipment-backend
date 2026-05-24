# SPEC.md — Herramientas y Equipos Retirados (App Wifix)

**Proyecto:** Módulo de Herramientas y Equipos Retirados de la app Wifix
(Fase 1).
**Responsable:** Franco — Tulpa Solutions S.A.S.
**Contrato de API:** `openapi-herramientas-equipos.yaml` (fuente de verdad
de todos los endpoints).
**Repositorio del frontend existente:** `wifix-webapp`
(https://github.com/kransta5934-hub/wifix-webapp).

---

## 1. Propósito

Construir, para la app Wifix, el módulo completo de dos dominios:

1. **Herramientas** — medición de distancia, test de velocidad, mapa de
   calor WiFi, ping y traceroute.
2. **Equipos retirados** — registro de equipos retirados o reemplazados.

A diferencia de un plan solo-backend, este módulo entrega **dos piezas**:

- **Backend:** un servicio independiente que persiste los datos y expone
  la API del contrato.
- **Frontend:** las pantallas de Herramientas y Equipos Retirados, que se
  agregan al repositorio `wifix-webapp` siguiendo el mismo modelo y los
  mismos formatos que ya definió el socio.

El módulo es **append-only**: registra resultados de campo; no expone
edición ni borrado de los registros transaccionales.

---

## 2. Alcance

### Incluye
- Backend con catálogos, persistencia de los 5 tipos de herramienta,
  registro de equipos retirados, subida de fotos e historial por cuenta.
- Pantallas de **Herramientas** y **Equipos Retirados** en `wifix-webapp`,
  reutilizando los componentes y estilos existentes.
- Capa de consumo de API en el frontend (aislada, lista para apuntar al
  backend real).

### NO incluye
- Las pantallas y datos del socio: Datos Personales, Datos del Servicio,
  Red Interna (son de su parte del proyecto).
- Autenticación / login / emisión de tokens — ver sección 11.
- Ejecución nativa de las pruebas de red — ver la **nota técnica** de la
  sección 15.

---

## 3. Identificación de registros (Fase 1)

El frontend identifica al cliente por el **número de cuenta** que el
técnico escribe en la pantalla. Esa es la clave práctica de la Fase 1.

- `accountNumber` — **obligatorio** en todo registro transaccional.
- `clientId`, `visitId`, `technicianId` — **opcionales**. Provendrán de un
  sistema upstream aún por definir; en la Fase 1 se completan con valores
  de prueba (datos supuestos generados por el frontend).
- `contractId` — **opcional**. En una fase posterior será reemplazado por
  `taskId`; el modelo de datos debe permitir ese cambio sin migración
  traumática (ver sección 7).

No hay entidad de cliente, contrato, visita ni técnico en este módulo:
solo se guardan esos identificadores como texto.

---

## 4. Arquitectura general

Dos piezas independientes que se comunican por HTTP:

```
   wifix-webapp (frontend)            backend (servicio nuevo)
   ┌─────────────────────┐            ┌──────────────────────┐
   │ Pantallas Herram. + │  HTTP/JSON │ API del contrato     │
   │ Equipos Retirados   │ ─────────► │ OpenAPI              │
   │ capa de API aislada │            │ PostgreSQL + storage │
   └─────────────────────┘            └──────────────────────┘
```

El frontend se desarrolla en el repo `wifix-webapp`; el backend en un
repositorio (o carpeta) propio. Se conectan al final apuntando la capa de
API del frontend a la URL del backend.

---

## 5. Stack tecnológico

### Backend (servicio nuevo)

| Componente      | Elección                                       |
|-----------------|------------------------------------------------|
| Runtime         | Node.js 20 LTS                                 |
| Lenguaje        | TypeScript (modo `strict`)                     |
| Framework HTTP  | Fastify                                        |
| ORM             | Prisma                                         |
| Base de datos   | PostgreSQL 15+                                 |
| Validación      | Zod                                            |
| Almacenamiento  | S3-compatible (AWS S3 en prod, MinIO en local) |
| Logging         | pino                                           |
| Pruebas         | Vitest + Supertest                             |
| Entorno local   | Docker Compose (PostgreSQL + MinIO)            |

> El backend es un servicio independiente: no hay un backend previo al
> cual igualarse, así que este stack queda fijado.

### Frontend (en `wifix-webapp`)

HTML / CSS / JavaScript **puro (vanilla)**, sin framework ni paso de
build, **idéntico al stack del repositorio existente**. Las pantallas
nuevas deben reutilizar la estructura, los componentes y los tokens de
diseño de `index.html`, `app.js` y `styles.css`. Se sirve en local con
`npx http-server . -p 5173`.

---

## 6. Estructura de archivos

### Backend

```
.
├── openapi-herramientas-equipos.yaml
├── SPEC.md
├── PROMPT.md
├── docker-compose.yml          # PostgreSQL + MinIO
├── .env.example
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── src/
│   ├── config/                 # carga y validación de variables de entorno
│   ├── db/                     # cliente Prisma
│   ├── middleware/             # manejador de errores, validación
│   ├── modules/
│   │   ├── catalogs/
│   │   ├── tools/
│   │   │   ├── distance/
│   │   │   ├── speedtest/
│   │   │   ├── heatmap/
│   │   │   ├── ping/
│   │   │   └── traceroute/
│   │   ├── retired-equipment/
│   │   ├── media/
│   │   └── account-history/
│   ├── schemas/                # esquemas Zod
│   ├── lib/                    # adaptador de almacenamiento, utilidades
│   ├── app.ts
│   └── server.ts
└── tests/
```

Cada módulo en capas: **routes** → **service** → **repository**.

### Frontend (cambios sobre `wifix-webapp`)

- `index.html` — agregar las nuevas `<section>` de pantalla (Herramientas
  y Equipos Retirados) y la nueva tarjeta del sub-menú.
- `app.js` — conectar la sub-tarjeta `herramientas` (hoy es un botón sin
  función), agregar la de equipos retirados, y los renderizadores de las
  pantallas nuevas.
- `styles.css` — agregar los estilos nuevos al final, siguiendo la
  nomenclatura de clases existente.
- `api.js` (**nuevo**) — capa de consumo de API aislada (ver sección 15).

---

## 7. Modelo de datos (backend)

### Convenciones
- Tablas y columnas en **snake_case**; campos de la API en **camelCase**
  (Prisma mapea con `@map`).
- Identificadores propios: `UUID` v4.
- Fechas: `timestamptz` en UTC. Toda tabla transaccional lleva `created_at`.

### Columnas de contexto (en cada tabla transaccional)

| Columna         | Tipo | Nulo | Notas                                 |
|-----------------|------|------|---------------------------------------|
| `account_number`| text | no   | Clave de Fase 1. **Indexar.**         |
| `client_id`     | text | sí   | Referencia upstream. Indexar.         |
| `contract_id`   | text | sí   | Referencia upstream; futuro `task_id`.|
| `visit_id`      | text | sí   | Referencia upstream. Indexar.         |
| `technician_id` | text | sí   | Referencia upstream.                  |

> Sobre `contract_id` → `task_id`: mantener la columna genérica y no atarla
> a lógica de negocio. El cambio futuro será principalmente de
> nomenclatura; documentarlo para no olvidarlo.

### Tablas de catálogo
- **`equipment_models`**: `id` (uuid PK), `name`, `category` (enum),
  `serial_field_type` (enum), `brand` (nulo), `active`.
- **`removal_reasons`**: `code` (text PK), `label`, `sort_order`, `active`.
- **`speedtest_servers`**: `id` (uuid PK), `name`, `host`, `city` (nulo),
  `latitude`/`longitude` (nulos), `active`.
- **`network_servers`**: `id` (uuid PK), `name`, `target`, `type` (enum),
  `active`.

### Tablas transaccionales
- **`distance_measurements`**: contexto, `distance_meters`,
  `start_lat`/`start_lng`/`end_lat`/`end_lng` (nulos), `measured_at`,
  `notes`, `created_at`.
- **`speedtests`**: contexto, `download_mbps`, `upload_mbps`,
  `latency_ms`/`jitter_ms`/`packet_loss_percent` (nulos), `server_id`
  (nulo), `server_name` (nulo), `isp_name` (nulo), `measured_at`, `notes`,
  `created_at`.
- **`wifi_heatmaps`**: contexto, `label` (nulo), `notes` (nulo),
  `created_at`.
- **`wifi_heatmap_rooms`**: `id`, `heatmap_id` (FK cascade), `room_name`,
  `floor` (default 1), `signal_dbm`, `measured_at`, `notes` (nulo).
- **`ping_tests`**: contexto, `target`, `server_id` (nulo),
  `packets_sent`/`packets_received` (nulos), `packet_loss_percent` (nulo),
  `min/avg/max_latency_ms` (nulos), `continuous` (default false),
  `heatmap_id` (FK, nulo), `room_name` (nulo), `measured_at`, `notes`,
  `created_at`.
- **`traceroute_tests`**: contexto, `target`, `server_id` (nulo),
  `measured_at`, `notes`, `created_at`.
- **`traceroute_hops`**: `id`, `traceroute_test_id` (FK cascade),
  `hop_number`, `host` (nulo), `latency_ms` (nulo).
- **`retired_equipment`**: contexto, `equipment_model_id` (FK),
  `serial_value`, `serial_field_type` (enum — **snapshot** del modelo al
  registrar), `barcode_photo_id` (FK → `media_files`, nulo),
  `removal_reason_code` (FK), `observations` (nulo), `retired_at`,
  `created_at`.
- **`media_files`**: `id` (uuid PK), `storage_key`, `url`, `content_type`,
  `size_bytes`, `created_at`.

### Índices
`account_number`, `client_id`, `visit_id` en las tablas transaccionales;
`measured_at`/`retired_at` para los filtros por fecha; `serial_value` en
`retired_equipment`.

---

## 8. Datos semilla (seed)

`prisma/seed.ts` debe poblar:

### `equipment_models`

| name                  | category        | serial_field_type |
|-----------------------|-----------------|-------------------|
| Decodificadores       | DECODIFICADOR   | SN                |
| Decodificadores HD    | DECODIFICADOR_HD| HOST-SN           |
| MTA                   | MTA             | SN                |
| ONU300G               | ONU             | PON-SN            |
| ONU HUR               | ONU             | PON-SN            |
| ONU B2000             | ONU             | SN                |
| ONT Huawei OptiXstar  | ONT             | SN                |
| ONT ZTE (todas)       | ONT             | GPON-SN           |
| Router Huawei         | ROUTER          | SN                |
| Router ZTE            | ROUTER          | D-SN              |

### `removal_reasons`

| code                   | label                                       |
|------------------------|----------------------------------------------|
| DANO_FISICO            | Daño físico                                  |
| NO_ENCIENDE            | No enciende                                  |
| PUERTO_DANADO          | Puerto LAN o RF dañado (no da conectividad)  |
| EQUIPO_INHIBIDO        | Equipo inhibido                              |
| NO_DA_SERVICIO         | No da servicio (navegación, WiFi)            |
| NO_SE_APROVISIONA      | No se aprovisiona                            |
| EQUIPO_OK_CANCELACION  | Equipo OK (cancelación)                      |
| OTROS                  | Otros                                        |

`speedtest_servers` y `network_servers` se siembran con ejemplos (p. ej.
Google DNS `8.8.8.8`, Cloudflare `1.1.1.1`); su contenido real se define
después.

---

## 9. Endpoints

`openapi-herramientas-equipos.yaml` es la **fuente de verdad**. La
implementación debe coincidir exactamente con él. Si se detecta que el
contrato necesita un cambio, **no se modifica el código en silencio**: se
anota y se acuerda con el socio. Resumen:

| Grupo             | Endpoints                                            |
|-------------------|------------------------------------------------------|
| Catálogos         | GET de speedtest-servers, network-servers, equipment-models, removal-reasons |
| Herramientas      | POST / GET lista / GET por id de cada una            |
| Equipos retirados | POST / GET lista / GET por id de retired-equipment   |
| Media             | POST /media, GET /media/{id}                         |
| Historial         | GET /accounts/{accountNumber}/tool-history           |

---

## 10. Reglas de negocio

**Generales**
- `accountNumber` obligatorio en todo POST transaccional.
- `measuredAt` / `retiredAt` no deben ser futuras (tolerancia 5 minutos).
- Paginación: `page ≥ 1`, `pageSize` entre 1 y 100 (default 20).

**Test de velocidad** — `downloadMbps` y `uploadMbps` obligatorios y `≥ 0`.

**Mapa de calor WiFi** — al menos una habitación; `floor` por defecto 1;
`signalDbm` se acepta negativo, rechazar fuera del rango −120 a 0.

**Ping** — si se envían ambos, `packetsReceived ≤ packetsSent`;
`heatmapId`, si se envía, debe existir.

**Equipos retirados** — `equipmentModelId` y `removalReasonCode` deben
existir en catálogo (`CATALOG_ITEM_NOT_FOUND` si no); `serial_field_type`
se copia del modelo al crear el registro; `barcodePhotoId`, si se envía,
debe existir (`MEDIA_NOT_FOUND` si no).

---

## 11. Autenticación

**La Fase 1 NO tiene autenticación.** Sin login, sin API key, sin token.
Los endpoints del backend son abiertos. La autenticación (JWT u otro
mecanismo) se incorporará en una fase posterior; el código debe quedar
estructurado de modo que agregar un middleware de autenticación más
adelante no obligue a reescribir los módulos.

---

## 12. Almacenamiento de archivos

- `POST /media` recibe `multipart/form-data`, sube a un bucket
  S3-compatible y devuelve `{ id, url, contentType, sizeBytes, createdAt }`.
- En desarrollo se usa **MinIO** vía Docker Compose; en producción AWS S3
  u otro compatible. El adaptador de almacenamiento se aísla en `src/lib/`.
- Tipos permitidos: `image/jpeg`, `image/png`. Tamaño máximo: 10 MB
  (configurable).

---

## 13. Manejo de errores

Todas las respuestas de error usan el esquema `Error` del OpenAPI:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "El campo accountNumber es obligatorio.",
  "details": [{ "field": "accountNumber", "issue": "requerido" }]
}
```

| Código                  | HTTP | Uso                                   |
|-------------------------|------|---------------------------------------|
| `VALIDATION_ERROR`      | 400  | Cuerpo o parámetros inválidos         |
| `NOT_FOUND`             | 404  | Recurso transaccional inexistente     |
| `CATALOG_ITEM_NOT_FOUND`| 404  | Modelo o motivo de catálogo inexistente|
| `MEDIA_NOT_FOUND`       | 404  | `barcodePhotoId` inexistente          |
| `INTERNAL_ERROR`        | 500  | Error no controlado                   |

Mensajes (`message`) en español; códigos en inglés.

---

## 14. Variables de entorno (backend)

| Variable             | Descripción                          |
|----------------------|--------------------------------------|
| `NODE_ENV`           | `development` / `production`         |
| `PORT`               | Puerto HTTP (default 8080)            |
| `DATABASE_URL`       | Cadena de conexión PostgreSQL         |
| `STORAGE_ENDPOINT`   | Endpoint S3 / MinIO                   |
| `STORAGE_REGION`     | Región del bucket                     |
| `STORAGE_BUCKET`     | Nombre del bucket                     |
| `STORAGE_ACCESS_KEY` | Llave de acceso                       |
| `STORAGE_SECRET_KEY` | Llave secreta                         |
| `LOG_LEVEL`          | Nivel de log de pino                  |
| `CORS_ORIGIN`        | Origen permitido para el frontend     |

> No hay variables de JWT en la Fase 1.

---

## 15. Frontend — pantallas a construir

Las pantallas nuevas se agregan a `wifix-webapp` **replicando los patrones
existentes**. Antes de codificar, estudiar `index.html`, `app.js` y
`styles.css` para reutilizar:

- El contenedor `.phone-frame > .app`, la `.status-bar` y el fondo.
- El patrón de pantalla deslizante: `<section>` con clase `detailscreen`,
  que se abre/cierra con la clase `.open` y el atributo `aria-hidden`.
- El `.sub-header` con `.back-btn` y el `.account-chip`.
- El patrón de acordeón de `Datos del Servicio` (`SERVICIO_ITEMS`: cada
  ítem con cabecera, cuerpo colapsable y función `render()`).
- Los tokens de diseño y la nomenclatura de clases de `styles.css`.

### Pantallas

**Herramientas** — hoy la sub-tarjeta `data-sub="herramientas"` existe
pero no hace nada. Conectarla para que abra una pantalla con las 5
herramientas: medición de distancia, test de velocidad, mapa de calor
WiFi, ping y traceroute. Cada herramienta permite capturar su resultado y
guardarlo.

**Equipos Retirados** — agregar una nueva `.sub-card` al `.sub-grid` (junto
a las 4 existentes) que abra una pantalla con el formulario de retiro:
número de serie, modelo (desplegable desde el catálogo), motivo de retiro
(desplegable), observaciones y foto del código de barras.

### Capa de API (`api.js`)

Crear un módulo `api.js` que centralice todo el consumo del backend:
- Una constante `API_BASE_URL` configurable en un solo lugar.
- Una función por endpoint del contrato.
- Igual que el código actual del repo —cuyos `build*Mock()` están
  "ready to be swapped for real API calls"—, **construir primero con
  funciones mock** y dejar el cambio a `fetch()` real concentrado en este
  único archivo. Así el resto de la pantalla no se entera de si los datos
  son simulados o reales.
- Los identificadores `clientId` / `visitId` / `technicianId` se rellenan
  en esta capa con valores de prueba mientras no exista el sistema
  upstream; `accountNumber` viene del campo de cuenta que el técnico
  ingresa.

### ⚠️ Nota técnica importante — limitación de una webapp

`wifix-webapp` es una **webapp de navegador**. Un navegador **no puede
ejecutar ping ni traceroute** (requieren ICMP, no disponible en
JavaScript) ni **leer la potencia WiFi en dBm** (requiere APIs nativas del
sistema operativo). El test de velocidad sí es parcialmente posible en el
navegador (medición de descarga/subida por tiempo de transferencia).

Implicación para la Fase 1: las pantallas de ping, traceroute y mapa de
calor deben diseñarse para que el técnico **ingrese los resultados
manualmente** (o usar datos mock para las pruebas). Ejecutar realmente
esas pruebas requeriría, más adelante, envolver la webapp en un contenedor
nativo (p. ej. Capacitor) o una app nativa complementaria — **esa es una
decisión a coordinar con el socio**.

El **backend no se ve afectado** por esto: guarda los resultados igual,
provengan de una medición real, de una entrada manual o de un mock.

---

## 16. Convenciones de código

- Backend: TypeScript `strict`, sin `any` implícito; validación de entrada
  con Zod en la capa de routes.
- Nombres de campo de API en `camelCase`; columnas de BD en `snake_case`.
- Frontend: respetar el estilo de código y la nomenclatura de clases del
  repo existente.
- Comentarios y mensajes al usuario en español; nombres de variables,
  funciones y tipos en inglés.
- Commits con Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`).

---

## 17. Pruebas

- Backend: pruebas unitarias de la lógica de servicios (reglas de la
  sección 10) y de integración por endpoint (casos de éxito y de error).
  Verificar que las respuestas coinciden con los esquemas del OpenAPI.
  Corren con `npm test`.
- Frontend: verificación manual de cada pantalla en el navegador y de la
  capa `api.js` (modo mock y, al final, modo real contra el backend).

---

## 18. Criterios de aceptación

### Backend
- [ ] Compila (`npm run build`) y el linter pasa sin errores.
- [ ] `docker-compose up` levanta PostgreSQL y MinIO; migraciones y seed
      corren sin fallos.
- [ ] Todos los endpoints del OpenAPI están implementados y responden
      según el contrato.
- [ ] Catálogos de modelos de equipo y motivos de retiro sembrados con los
      datos de la sección 8.
- [ ] Reglas de negocio de la sección 10 validadas y cubiertas por pruebas.
- [ ] Ninguna tabla guarda más que IDs de `client`/`contract`/`visit`/
      `technician`; `accountNumber` es la clave práctica.
- [ ] La suite de pruebas pasa con `npm test`.
- [ ] `README.md` con instrucciones de instalación y arranque.

### Frontend
- [ ] La sub-tarjeta "Herramientas" abre una pantalla funcional con las 5
      herramientas.
- [ ] Existe la sub-tarjeta "Equipos Retirados" y abre su formulario.
- [ ] Las pantallas nuevas reutilizan los componentes y estilos del repo
      existente sin romper las pantallas del socio.
- [ ] `api.js` centraliza el consumo y permite alternar mock / backend
      real cambiando un solo punto.
