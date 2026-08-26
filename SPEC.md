# SPEC.md — App Wifix Certificate (módulo completo)

**Proyecto:** App Wifix Certificate para técnicos de campo.
**Responsable:** Franco — Tulpa Solutions S.A.S.
**Contrato de API:** `openapi-herramientas-equipos.yaml` (fuente de verdad).
**Repositorio del frontend:** `wifix-webapp`.

---

## 1. Propósito

Construir la app Wifix completa: backend y frontend. La app cubre dos
naturalezas de datos distintas:

- **Datos que la app genera** (Herramientas y Equipos Retirados, campos
  22-27) — el backend los **persiste**. CRUD clásico.
- **Datos que viven en sistemas de la operadora** (campos 1-21) — el
  backend los **integra** desde Comarch/TYTAN, FSM, ISP Monitor, ACS, TEC
  y RMS.

En esta etapa, los datos de los sistemas externos se sirven con
**información simulada (mockup)** para demostrar y probar la app. Las APIs
reales se conectarán al final sin cambiar el contrato.

La app tiene además un **login propio**.

---

## 2. Alcance

### Incluye
- **Backend:** login + JWT; persistencia de Herramientas y Equipos
  Retirados; capa de conectores hacia los sistemas externos (en modo
  mock); endpoints de integración de los campos 1-21; subida de fotos.
- **Frontend:** pantalla de login y todas las pantallas de la app en
  `wifix-webapp`.

### NO incluye (por ahora)
- La conexión real a las APIs de la operadora: los conectores quedan en
  modo mock; las APIs reales se conectan al final (sección 9).
- Ejecución nativa de las pruebas de red — ver nota técnica de la
  sección 16.

> Si Herramientas y Equipos Retirados ya están construidos, se reutilizan
> tal cual; este SPEC los documenta para mantener el panorama completo.

---

## 3. Identificación y login

- `accountNumber` (número de cuenta que el técnico ingresa) es la **clave
  práctica** de todos los datos del cliente.
- `clientId` / `visitId` / `technicianId` son opcionales; `contractId` se
  renombrará a `taskId` en el futuro (los URLs de FSM ya usan el formato
  `TASK/294328/2026`).
- La app tiene login. El usuario inicial es **franco@tulpasolutions.com**
  (sembrado por seed; la contraseña se define por variable de entorno —
  sección 14).

---

## 4. Arquitectura general

```
   wifix-webapp (frontend)             backend (servicio)
   ┌──────────────────────┐            ┌───────────────────────────────┐
   │ Login + pantallas    │  HTTP/JSON │ Auth (JWT)                    │
   │ capa de API aislada  │ ─────────► │ Persistencia (Postgres)       │
   └──────────────────────┘            │ Conectores ──► sistemas       │
                                       │   (modo mock / real)  externos│
                                       └───────────────────────────────┘
```

Los **conectores** aíslan cada sistema externo. Hoy corren en modo mock;
al final se cambian a modo real apuntando a las APIs de la operadora.

---

## 5. Stack tecnológico

### Backend

| Componente      | Elección                                       |
|-----------------|------------------------------------------------|
| Runtime         | Node.js 20 LTS                                 |
| Lenguaje        | TypeScript (modo `strict`)                     |
| Framework HTTP  | Fastify                                        |
| ORM             | Prisma                                         |
| Base de datos   | PostgreSQL 15+                                 |
| Autenticación   | JWT (`jose`) + hashing de contraseñas (`bcrypt`)|
| Validación      | Zod                                            |
| Almacenamiento  | S3-compatible (AWS S3 en prod, MinIO en local) |
| Logging         | pino                                           |
| Pruebas         | Vitest + Supertest                             |
| Entorno local   | Docker Compose (PostgreSQL + MinIO)            |

### Frontend

HTML / CSS / JavaScript **puro**, sin framework ni build, idéntico al
stack de `wifix-webapp`. Se sirve con `npx http-server`.

---

## 6. Estructura de archivos (backend)

```
.
├── openapi-herramientas-equipos.yaml
├── SPEC.md  ·  PROMPT.md
├── docker-compose.yml          # PostgreSQL + MinIO
├── .env.example
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── src/
│   ├── config/
│   ├── db/
│   ├── auth/                   # login, emisión y validación de JWT
│   ├── middleware/             # auth, manejador de errores, validación
│   ├── connectors/             # un módulo por sistema externo
│   │   ├── comarch/            # TYTAN — datos de cliente y contrato
│   │   ├── fsm/                # tareas y observaciones de cierre
│   │   ├── ispmonitor/         # métricas de red
│   │   ├── acs/                # red local y configuración WiFi
│   │   ├── tec/                # NAPs y registro GPON
│   │   └── rms/                # eventos del nodo
│   ├── modules/
│   │   ├── catalogs/
│   │   ├── tools/              # distance, speedtest, heatmap, ping, traceroute
│   │   ├── retired-equipment/
│   │   ├── media/
│   │   ├── account-history/
│   │   ├── client-data/        # campos 1-5, 7   (usa connectors/comarch)
│   │   ├── network-diagnostics/# campos 6, 8-14, 19-21 (usa varios connectors)
│   │   └── tasks-visits/       # campos 15-16    (usa connectors/fsm)
│   ├── schemas/                # esquemas Zod
│   ├── lib/
│   ├── app.ts  ·  server.ts
└── tests/
```

Cada módulo en capas: **routes** → **service** → (**repository** para
datos persistidos / **connector** para datos externos).

---

## 7. Modelo de datos (backend)

### Convenciones
Tablas/columnas en `snake_case`, campos de API en `camelCase`. IDs
propios `UUID` v4. Fechas `timestamptz` en UTC.

### Tablas
- **`users`** (NUEVA) — `id` (uuid PK), `email` (text único),
  `password_hash` (text), `name` (text), `active` (bool, default true),
  `created_at`.
- Tablas de **catálogo** y **transaccionales** de Herramientas y Equipos
  Retirados: sin cambios respecto a la versión previa de este SPEC
  (`equipment_models`, `removal_reasons`, `speedtest_servers`,
  `network_servers`, `distance_measurements`, `speedtests`,
  `wifi_heatmaps`, `wifi_heatmap_rooms`, `ping_tests`, `traceroute_tests`,
  `traceroute_hops`, `retired_equipment`, `media_files`). Toda tabla
  transaccional lleva `account_number` (obligatorio, indexado) más
  `client_id` / `contract_id` / `visit_id` / `technician_id` (opcionales).

### Sin tablas para los campos 1-21
Los datos de los sistemas externos **no se persisten**: los entregan los
conectores. En modo mock se generan al vuelo; en modo real vienen de las
APIs de la operadora.

---

## 8. Datos semilla (seed)

`prisma/seed.ts` debe poblar:

- **Usuario inicial:** `franco@tulpasolutions.com`, con la contraseña de
  `SEED_USER_PASSWORD` (hasheada con bcrypt) y nombre de `SEED_USER_NAME`.
- **`equipment_models`** y **`removal_reasons`**: los datos de la sección
  8 de la versión previa del SPEC (10 modelos de equipo y 8 motivos de
  retiro tomados del Excel).
- **`speedtest_servers`** / **`network_servers`**: ejemplos.

---

## 9. Capa de conectores (datos de sistemas externos)

Cada sistema de la operadora tiene un **conector** en `src/connectors/`.
El conector define una **interfaz** (las operaciones que el módulo
necesita) y tiene **dos implementaciones**:

- **Mock** — devuelve datos simulados. Es la que se usa ahora.
- **Real** — llama a la API del sistema. Queda como esqueleto con `TODO`;
  se completa cuando entreguen credenciales y endpoints.

Una variable de entorno `CONNECTOR_MODE` (`mock` | `real`) selecciona la
implementación. Debe poder fijarse globalmente y, si conviene, por
conector.

### Reglas de los mocks
- **Deterministas por clave:** los datos simulados de una misma
  `accountNumber` (o `napCode`) deben ser **estables entre llamadas** —
  sembrar el generador pseudoaleatorio con esa clave. Así una demo es
  consistente: el mismo cliente muestra siempre el mismo nombre.
- Datos realistas y en español (nombres, direcciones, equipos, motivos).
- Las **escrituras** en modo mock (`PUT client-profile`, `PUT
  wifi-config`) devuelven una respuesta de éxito simulada sin persistir.

### Mapa conector → sistema → campos

| Conector     | Sistema (real)         | Campos                  |
|--------------|------------------------|-------------------------|
| `comarch`    | TYTAN / Comarch CM     | 1, 2, 3, 4, 5, 7        |
| `fsm`        | FSM                    | 15, 16                  |
| `ispmonitor` | ISP Monitor            | 9, 10, 11, 12, 13       |
| `acs`        | ACS (TR-069)           | 19, 20, 21              |
| `tec`        | TEC / registro GPON    | 6, 8                    |
| `rms`        | RMS                    | 14                      |

> Campos 17 y 18 no usan conectores: los sirve el módulo de Herramientas
> (historial de la cuenta y de tests de velocidad ya persistidos).

---

## 10. Endpoints

`openapi-herramientas-equipos.yaml` es la **fuente de verdad**. Resumen:

| Grupo              | Endpoints                                          |
|--------------------|----------------------------------------------------|
| Autenticación      | POST /auth/login, GET /auth/me                     |
| Catálogos          | 4 endpoints GET                                    |
| Herramientas       | POST / GET lista / GET por id de cada una          |
| Equipos retirados  | POST / GET lista / GET por id                      |
| Media              | POST /media, GET /media/{id}                       |
| Historial          | GET /accounts/{accountNumber}/tool-history         |
| Datos del Cliente  | client-profile (GET/PUT), contract-status          |
| Diagnóstico de Red | nearby-naps, naps/{napCode}/ports, network-metrics, node-events, lan-devices, wifi-devices, wifi-config (GET/PUT) |
| Tareas y Visitas   | unsatisfactory-tasks, previous-visits              |

---

## 11. Reglas de negocio

- Herramientas y Equipos Retirados: reglas sin cambios respecto a la
  versión previa del SPEC (`accountNumber` obligatorio, validación de
  catálogos, snapshot de `serialFieldType`, etc.).
- `PUT /accounts/{accountNumber}/wifi-config` y `PUT
  /accounts/{accountNumber}/client-profile` son **operaciones de
  escritura sensibles**: validar bien la entrada y registrar en el log
  quién (usuario autenticado) y cuándo se ejecutaron.
- En modo mock, una `accountNumber` o `napCode` desconocida puede generar
  datos igualmente (mock determinista) o responder `NOT_FOUND` según se
  decida; ser consistente.

---

## 12. Autenticación

- **`POST /auth/login`** recibe `email` y `password`, verifica contra la
  tabla `users` (bcrypt) y devuelve un **JWT** (HS256, firmado con
  `JWT_SECRET`) más los datos del usuario.
- **`GET /auth/me`** devuelve el usuario del token.
- Un **middleware** valida el JWT en todos los endpoints **excepto**
  `POST /auth/login` y el `GET /health` interno. Token ausente, inválido
  o expirado, o credenciales incorrectas → `401` con código
  `UNAUTHORIZED`.
- Usuario inicial sembrado: `franco@tulpasolutions.com`.

---

## 13. Almacenamiento de archivos

`POST /media` recibe `multipart/form-data`, sube a un bucket S3-compatible
(MinIO en local) y devuelve `{ id, url, contentType, sizeBytes,
createdAt }`. Tipos: `image/jpeg`, `image/png`. Máximo 10 MB. El adaptador
de almacenamiento se aísla en `src/lib/`.

---

## 14. Manejo de errores

Esquema `Error` del OpenAPI (`code`, `message`, `details`).

| Código                  | HTTP | Uso                                  |
|-------------------------|------|--------------------------------------|
| `VALIDATION_ERROR`      | 400  | Cuerpo o parámetros inválidos        |
| `UNAUTHORIZED`          | 401  | Token/credenciales inválidos         |
| `NOT_FOUND`             | 404  | Recurso inexistente                  |
| `CATALOG_ITEM_NOT_FOUND`| 404  | Modelo o motivo de catálogo inexistente|
| `MEDIA_NOT_FOUND`       | 404  | `barcodePhotoId` inexistente         |
| `CONNECTOR_ERROR`       | 502  | Fallo de un sistema externo (modo real)|
| `INTERNAL_ERROR`        | 500  | Error no controlado                  |

Mensajes en español; códigos en inglés.

---

## 15. Variables de entorno (backend)

| Variable             | Descripción                                  |
|----------------------|----------------------------------------------|
| `NODE_ENV`           | `development` / `production`                 |
| `PORT`               | Puerto HTTP (default 8080)                    |
| `DATABASE_URL`       | Conexión PostgreSQL                           |
| `JWT_SECRET`         | Secreto para firmar el JWT                    |
| `JWT_EXPIRES_IN`     | Vigencia del token (p. ej. `12h`)             |
| `SEED_USER_EMAIL`    | Correo del usuario inicial                    |
| `SEED_USER_PASSWORD` | Contraseña del usuario inicial                |
| `SEED_USER_NAME`     | Nombre del usuario inicial                    |
| `CONNECTOR_MODE`     | `mock` o `real`                               |
| `STORAGE_ENDPOINT` / `STORAGE_REGION` / `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | Almacenamiento de archivos |
| `LOG_LEVEL`          | Nivel de log                                  |
| `CORS_ORIGIN`        | Origen permitido del frontend                 |

> Las URLs y credenciales de los sistemas externos (uno por conector) se
> agregan cuando se pase a `CONNECTOR_MODE=real`.

---

## 16. Frontend — pantallas

Las pantallas se construyen en `wifix-webapp` reutilizando los patrones
del repo: contenedor `.phone-frame`, pantallas deslizantes con `.open` y
`aria-hidden`, `.sub-header` con `.back-btn`, `.account-chip`, el acordeón
de `Datos del Servicio`, y los tokens de `styles.css`.

### Pantallas a construir / completar
- **Login** — pantalla de entrada de la app: correo y contraseña, llama a
  `POST /auth/login`, guarda el token y abre el menú principal.
- **Datos Personales** (campos 1-5) — incluye el **módulo de actualización
  de datos** (campo 4): formulario editable que llama al `PUT
  client-profile`.
- **Datos del Servicio** (campos 6-18) — NAPs, status, puertos por NAP
  (con foto del código de la NAP), métricas de red, eventos del nodo,
  tareas insatisfactorias, visitas anteriores, e historial de la app
  (campos 17-18, desde el módulo de Herramientas).
- **Red Interna** (campos 19-21) — equipos en la red local, dispositivos
  WiFi por banda, y el formulario de **cambio de SSID y contraseña**.
- **Herramientas** y **Equipos Retirados** — ya construidas; se reutilizan.

### Capa de API (`api.js`)
Módulo único que centraliza el consumo: `API_BASE_URL`, el manejo del
token (guardarlo tras el login y enviarlo en `Authorization: Bearer`), y
una función por endpoint. Construir primero en modo mock y concentrar el
cambio a `fetch()` real en este archivo.

### ⚠️ Nota técnica — limitación de una webapp
Un navegador no puede ejecutar ping ni traceroute (requieren ICMP) ni leer
la potencia WiFi en dBm (requiere APIs nativas). Para esta etapa, esas
pantallas capturan resultados por ingreso manual o usan mocks. Ejecutar
realmente esas pruebas requeriría envolver la webapp en un contenedor
nativo (p. ej. Capacitor) — decisión a evaluar más adelante. El backend no
se ve afectado.

---

## 17. Convenciones de código

- Backend: TypeScript `strict`, sin `any` implícito; validación con Zod en
  routes; nunca registrar contraseñas ni tokens en los logs.
- Nombres de API en `camelCase`; columnas de BD en `snake_case`.
- Frontend: respetar el estilo y la nomenclatura de clases del repo.
- Comentarios y mensajes al usuario en español; código en inglés.
- Conventional Commits.

---

## 18. Pruebas

- Backend: unitarias de la lógica de servicios y de los conectores mock;
  de integración por endpoint (éxito, validación, 401, 404). Verificar
  contra los esquemas del OpenAPI. Corren con `npm test`.
- Frontend: verificación manual de cada pantalla, del login y de la capa
  `api.js` (modo mock y, al final, real).

---

## 19. Criterios de aceptación

### Backend
- [ ] Compila y el linter pasa; `docker-compose up` levanta PostgreSQL y
      MinIO; migraciones y seed corren sin fallos.
- [ ] `POST /auth/login` con `franco@tulpasolutions.com` devuelve un JWT;
      el resto de endpoints rechaza peticiones sin token válido.
- [ ] Todos los endpoints del OpenAPI están implementados y responden
      según el contrato.
- [ ] Los conectores tienen interfaz + implementación mock determinista;
      la real queda como esqueleto con `TODO`.
- [ ] `CONNECTOR_MODE` conmuta entre mock y real.
- [ ] La suite de pruebas pasa con `npm test`.
- [ ] `README.md` con instalación y arranque.

### Frontend
- [ ] La app abre en la pantalla de login y, tras autenticar, entra al
      menú.
- [ ] Existen y funcionan las pantallas de Datos Personales (con módulo de
      actualización), Datos del Servicio y Red Interna (con cambio de SSID
      y contraseña).
- [ ] `api.js` centraliza el consumo y el token, y permite alternar mock /
      backend real desde un solo punto.
- [ ] Las pantallas nuevas no rompen Herramientas ni Equipos Retirados.
