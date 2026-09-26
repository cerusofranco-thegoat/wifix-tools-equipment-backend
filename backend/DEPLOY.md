# Despliegue del backend de Wifix Certificate en un VPS (demo)

Artefactos de este directorio:

| Archivo                     | Para qué                                                        |
|-----------------------------|-----------------------------------------------------------------|
| `Dockerfile`                | Imagen multi-stage: `builder` → `tools` (migraciones) → `runtime`|
| `docker-compose.prod.yml`   | backend + postgres 15 + minio, volúmenes con nombre, red interna |
| `.env.production.example`   | Plantilla de todas las variables, sin un solo valor real         |
| `DEPLOY.md`                 | Este documento                                                   |

Lo que **no** está acá y hay que resolver en el VPS: el reverse proxy con TLS
(Caddy, nginx o DokPloy). El backend se publica solo en `127.0.0.1:8080`.

---

## 0. Antes de empezar

- Docker Engine + Docker Compose v2 en el VPS.
- Un dominio o subdominio apuntando al VPS (para el certificado).
- Decidido el modo de los conectores (ver §3). Para la demo:
  `CONNECTOR_MODE_FSM=fixture`, el resto en `mock`.

Contexto verificado del VPS Quasar (`203.161.49.68`):

- `apix.grupotvcable.com` (FSM): **IP autorizada** → se puede usar
  `CONNECTOR_MODE_FSM=real` cuando haya token/key vigentes.
- `tec-api.grupotvcable.com` (TEC / ISP Monitor): **bloqueado desde el VPS** →
  `CONNECTOR_MODE_TEC=mock` y `CONNECTOR_MODE_ISPMONITOR=mock`. Ponerlos en
  `real` deja las pantallas de diagnóstico devolviendo errores de red.

---

## 1. Traer el código y preparar el `.env`

```bash
git clone <repo> wifix && cd wifix/backend
cp .env.production.example .env
$EDITOR .env          # rellenar todo lo que está entre <>
chmod 600 .env        # contiene secretos
```

Checklist mínimo de variables que **hay que** cambiar (el resto tiene default
razonable):

| Variable                   | Por qué es obligatoria                                       |
|----------------------------|--------------------------------------------------------------|
| `POSTGRES_PASSWORD`        | Compose aborta si falta; va también dentro de `DATABASE_URL` |
| `DATABASE_URL`             | Host `postgres` (nombre del servicio), no `localhost`        |
| `JWT_SECRET`               | Con el default el servidor **no arranca** en `production`     |
| `SEED_USER_EMAIL/PASSWORD` | Usuario con el que se entra a la demo                         |
| `STORAGE_ACCESS_KEY/SECRET_KEY` | Credenciales root de MinIO (compose aborta si faltan)    |
| `STORAGE_PUBLIC_BASE_URL`  | URL pública de las fotos; con el default interno el APK no las ve |
| `CORS_ORIGIN`              | Debe incluir `http://localhost` y `https://localhost` (WebView de Capacitor) |
| `CONNECTOR_MODE_*`         | Ver §3                                                        |

Verificación rápida de que no quedó ningún placeholder:

```bash
grep -n '<' .env    # no debe devolver nada
```

⚠ El mismo `.env` cumple dos funciones: es el `env_file` del backend **y** la
fuente de interpolación de compose (`POSTGRES_PASSWORD`, `STORAGE_ACCESS_KEY`,
`STORAGE_SECRET_KEY`). Y ojo con `docker compose config`: imprime el contenido
del `.env` en claro, secretos incluidos — no pegarlo en un chat ni en un ticket.

## 2. Levantar la infraestructura y migrar

```bash
# 1. Construir e iniciar (postgres y minio primero, por los healthchecks)
docker compose -f docker-compose.prod.yml up -d --build

# 2. Migraciones: NUNCA `migrate dev` en un servidor.
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate

# 3. Catálogos + usuario de SEED_USER_*
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  migrate npx tsx prisma/seed.ts

# 4. (Opcional) usuario admin adicional, con credenciales propias
docker compose -f docker-compose.prod.yml --profile tools run --rm \
  -e ADMIN_EMAIL='admin@tudominio.com' \
  -e ADMIN_PASSWORD='<contraseña-larga>' \
  migrate npx tsx prisma/create-admin.ts
```

El servicio `migrate` corre `prisma migrate deploy` por defecto, se ejecuta una
vez y se borra (`--rm`). No queda nada corriendo.

`prisma/create-admin.ts` **exige** `ADMIN_EMAIL` y `ADMIN_PASSWORD` cuando
`NODE_ENV=production` (que es lo que pone el compose): sin ellas aborta con un
mensaje explícito, en vez de crear el viejo `admin@wifix.local` con una
contraseña que está escrita en el repositorio. La contraseña no se imprime en los
logs cuando viene del entorno. En desarrollo local, sin esas variables, sigue
cayendo a las credenciales de siempre.

Si preferís no tener un admin extra, alcanza con el usuario de `SEED_USER_*` que
crea `prisma/seed.ts`.

## 3. Modos de conector (la parte que decide qué ve el cliente)

```ini
CONNECTOR_MODE=mock            # base: todo simulado
CONNECTOR_MODE_FSM=fixture     # respuestas REALES grabadas, cero red
CONNECTOR_MODE_TEC=mock        # tec-api bloqueada desde el VPS
CONNECTOR_MODE_ISPMONITOR=mock
CONNECTOR_MODE_COMARCH=mock    # solo esqueleto: real = 502
CONNECTOR_MODE_ACS=mock
CONNECTOR_MODE_RMS=mock
NAPS_PRIMARY_SOURCE=fsm        # con respaldo automático a TEC si FSM falla
```

**`fixture`** sirve las respuestas reales de producción guardadas en
`tests/fixtures/fsm/` (cuenta **35070291**) pasándolas por el mismo
normalizador que el modo real, con la PII sustituida por datos demo. Cualquier
**otra** cuenta responde con el mock determinista. Es decir: en la demo hay una
cuenta "de verdad" (35070291) y el resto de la app sigue navegable.

La imagen de runtime incluye `tests/fixtures/` justamente para esto; si se quita
esa línea del `Dockerfile`, el modo `fixture` responde 502 con un mensaje
explícito.

Para pasar FSM a `real` en el VPS (que sí tiene la IP autorizada): ver §5.

## 4. Reverse proxy (fuera de estos archivos)

Dos rutas a publicar:

1. La API → `127.0.0.1:8080`.
2. Las fotos de MinIO → `minio:9000` (o `127.0.0.1:9001` si se descomenta el
   puerto). Debe coincidir con `STORAGE_PUBLIC_BASE_URL`, en formato path-style:
   `https://<dominio>/s3/<bucket>/<clave>`.

Ejemplo con Caddy:

```caddyfile
demo.wifix.example.com {
    handle_path /s3/* {
        reverse_proxy minio:9000     # o 127.0.0.1:9000 si se expone
    }
    reverse_proxy 127.0.0.1:8080
}
```

Con eso `STORAGE_PUBLIC_BASE_URL=https://demo.wifix.example.com/s3`.

El backend no necesita `X-Forwarded-*` para funcionar (no construye URLs
absolutas de sí mismo), pero conviene pasarlos para que los logs sirvan.

## 5. Rotar el token de FSM

FSM autentica con Bearer por marca y el token **vence cada 24 h**. Hay dos
caminos; el segundo es el que conviene en un VPS.

**a) Token estático (pegar a mano, dura 24 h)**

```bash
$EDITOR .env
# FSM_API_TOKEN_TELENEWS=<jwt nuevo>
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
```

**b) Renovación automática (recomendado)** — el backend negocia el token solo
contra el API manager de la operadora:

```ini
FSM_TOKEN_URL_TELENEWS=https://apix.grupotvcable.com/rest/token-api/v1.0/generate
FSM_TOKEN_KEY_TELENEWS=<key Basic base64 que entrega la operadora>
```

Si están URL + KEY, tienen prioridad sobre el token estático y no hay nada que
rotar a mano. `FSM_TOKEN_KEY_*` **no se commitea nunca**: vive solo en el `.env`
del servidor.

Comprobar el estado sin gastar una consulta a producción:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/herramientas/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"<SEED_USER_EMAIL>","password":"<SEED_USER_PASSWORD>"}' | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8080/herramientas/v1/integrations/fsm/health | jq
```

Responde el modo (`mock` / `real` / `fixture`), la marca por defecto y, por
marca, si hay token, de dónde sale y cuándo vence. **Cero** llamadas a la
operadora.

Que el token falte o venza **no tumba el servidor**: arranca igual, avisa por
consola y las rutas de FSM responden `503 UPSTREAM_AUTH_ERROR` con
`meta.reason` (`MISSING` / `EXPIRED` / `REJECTED`). Nunca un 401 — un 401 haría
que la app cierre la sesión del técnico en medio de una visita.

## 6. Verificación post-despliegue

```bash
# Health sin token (es lo que mira el healthcheck del contenedor)
curl -s http://127.0.0.1:8080/health | jq

# Login
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/herramientas/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"<SEED_USER_EMAIL>","password":"<SEED_USER_PASSWORD>"}' | jq -r .token)

# Catálogos (base de datos + seed)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8080/herramientas/v1/catalogs/equipment-models | jq '.[0]'

# La cuenta "real" de la demo (modo fixture): 27 órdenes reales de producción
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8080/herramientas/v1/accounts/35070291/client-profile | jq

curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8080/herramientas/v1/accounts/35070291/previous-visits | jq '.totalOrders'

# NAPs GPON reales de ese domicilio + puertos de la NAP 35874
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/herramientas/v1/naps/nearby?lat=-2.0761&lng=-79.8537' | jq
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8080/herramientas/v1/naps/35874/ports | jq '.occupiedPorts, .totalPorts'

# CORS del WebView de Capacitor (debe responder 204 con el origen reflejado)
curl -s -i -X OPTIONS http://127.0.0.1:8080/herramientas/v1/auth/login \
  -H 'Origin: https://localhost' \
  -H 'Access-Control-Request-Method: POST' | head -12
```

Ninguna de esas consultas sale a la red de la operadora con la configuración de
demo. Se puede confirmar mirando los logs: `docker compose -f
docker-compose.prod.yml logs -f backend`.

## 7. Operación

```bash
# Logs
docker compose -f docker-compose.prod.yml logs -f backend

# Reiniciar tras cambiar el .env (el env_file se lee al crear el contenedor)
docker compose -f docker-compose.prod.yml up -d --force-recreate backend

# Actualizar a una versión nueva del código
git pull
docker compose -f docker-compose.prod.yml up -d --build backend
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate

# Respaldo de la base
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U wifix wifix_tools | gzip > backup-$(date +%F).sql.gz

# Entrar a la base
docker compose -f docker-compose.prod.yml exec postgres psql -U wifix -d wifix_tools
```

Los datos viven en los volúmenes `wifix-postgres-data` y `wifix-minio-data`: un
`docker compose down` **no** los borra (`down -v` sí — no usarlo en el VPS).

## 8. Problemas típicos

| Síntoma | Causa probable |
|---|---|
| El contenedor no arranca y el log dice `[SEGURIDAD]` | `JWT_SECRET` quedó con el valor por defecto y `NODE_ENV=production` |
| El contenedor no arranca y el log dice `[CONFIG]` | `CONNECTOR_MODE_TEC/_ISPMONITOR=real` sin `TEC_API_USERNAME/PASSWORD` |
| Compose aborta antes de crear nada | Falta `POSTGRES_PASSWORD`, `STORAGE_ACCESS_KEY` o `STORAGE_SECRET_KEY` en el `.env` |
| `502 CONNECTOR_ERROR` en pantallas de diagnóstico | TEC/ISP Monitor en `real` desde el VPS: `tec-api` está bloqueada → volver a `mock` |
| `503 UPSTREAM_AUTH_ERROR` en las pantallas de FSM | Token ausente/vencido/rechazado (ver `meta.reason`). Rotar token (§5) o volver a `fixture` |
| `502` con "no se encontró el directorio tests/fixtures/fsm" | La imagen se construyó sin los fixtures y FSM está en `fixture` |
| Las fotos no se abren en el APK | `STORAGE_PUBLIC_BASE_URL` sin definir (apunta a `http://minio:9000`) o el proxy no enruta `/s3` |
| La app no puede llamar a la API desde el APK | Falta `http://localhost` / `https://localhost` en `CORS_ORIGIN` |

## 9. Política de privacidad (Google Play)

Publicada en `https://api-wifix.portaltulpa.com/privacidad` (alias `/privacy`).
Es la URL que se declara en Play Console → Política de privacidad y en el
formulario de Data Safety.

Cómo funciona: el HTML vive en el bucket público de MinIO
(`wifix-media/legal/privacidad.html`, fuente en `/opt/wifix-cert/legal/`) y
Traefik la sirve con una ruta `replacePath` definida en
`/etc/dokploy/traefik/dynamic/wifix-cert.yml`.

Para actualizarla: editar `/opt/wifix-cert/legal/privacidad.html` y re-subirla
(mc directo, sin sh — ver el comentario del compose sobre x86-64-v2):

```bash
cd /opt/wifix-cert/backend
A=$(grep '^STORAGE_ACCESS_KEY=' .env | cut -d= -f2-)
S=$(grep '^STORAGE_SECRET_KEY=' .env | cut -d= -f2-)
docker run --rm --network wifix \
  -e MC_HOST_local="http://$A:$S@wifix-minio:9000" \
  -v /opt/wifix-cert/legal:/legal:ro \
  quay.io/minio/mc:RELEASE.2024-01-13T08-44-48Z \
  cp /legal/privacidad.html local/wifix-media/legal/privacidad.html
```

## 10. Whitelist de clientes

Lista de cuentas reales de Xtrim contra la que la app valida "Confirmar cuenta"
(`GET /herramientas/v1/accounts/{n}/whitelist`). Se **reemplaza completa** en
cada refresco.

**Datos personales (LOPDP).** Las planillas de la operadora
(`CLIENTESSALDOSAS.xlsx`, `CLIENTESPRODUCTOSAS.xlsx`) traen nombre, dirección,
coordenadas y saldo de ~300k clientes: **nunca** suben al servidor ni al repo
(`.gitignore` y `.dockerignore` bloquean `*.xlsx` y `whitelist*.csv`). En local
se reducen a un CSV minimizado con solo: cuenta, cédula/RUC normalizada, estado,
ciudad, nodo, tipo de negocio, tipo de cuenta, tipo de acceso, CPARTY_ID y
**nombre** (desde el formato v2, 2026-09-26). Nada de dirección, coordenadas ni
saldo. La cédula/RUC se guarda en la base pero la API **no la devuelve nunca**;
el nombre tampoco sale por `/whitelist`: solo lo usa client-profile como
respaldo (ver 10.4).

### 10.1 Construir el CSV (en local, fuera del repo)

```bash
cd backend
npx tsx scripts/whitelist-build.ts \
  "C:/Users/<usuario>/Downloads/CLIENTESSALDOSAS.xlsx" \
  "C:/Users/<usuario>/Downloads/CLIENTESPRODUCTOSAS.xlsx" \
  --out "C:/Users/<usuario>/wifix-privado/whitelist.csv"
```

Lee en streaming (~15-30 s), imprime **solo conteos agregados** (cuentas, por
estado, documentos normalizados, con nombre…) y escribe el CSV. Reglas:

- Base = SALDOS (1 fila por cuenta); PRODUCTOS aporta tipo de cuenta y de acceso.
- Estado con varios productos: ACTIVO > SUSPENDIDO > ORDENADO > PENDIENTE; los
  tipos salen del producto de mayor prioridad.
- Cédula de 9 dígitos → 10 con cero inicial; RUC de 12 → 13. Otros largos
  (7-8 dígitos, pasaportes) quedan tal cual con `documentNormalized=false`.
- ACCOUNT_ID sin ceros a la izquierda (la ruta normaliza igual lo que se teclea).
- Nombre: FULLNAME de SALDOS; si viene vacío, el del producto de mayor
  prioridad. Se limpia igual que el resto del texto (encoding, espacios
  colapsados, sin caracteres de control).
- Formato **v2** (columna final `fullName`). El import también acepta el v1
  (sin nombre) pero avisa: esas cuentas quedan sin nombre de respaldo.

Si el script dice que "guarda las hojas antes de sharedStrings.xml", abrir la
planilla en Excel y guardarla de nuevo.

### 10.2 Subir e importar en el servidor

```bash
# Desde local: subir con permisos restringidos.
scp "C:/Users/<usuario>/wifix-privado/whitelist.csv" <usuario>@<vps>:~/whitelist.csv
```

```bash
# En el VPS
chmod 600 ~/whitelist.csv
cd /opt/wifix-cert/backend
git pull

# La imagen `tools` debe incluir el script: `up --build backend` NO la reconstruye.
docker compose -f docker-compose.prod.yml --profile tools build migrate
# Migración de las tablas (idempotente si ya estaba aplicada).
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate

# Import: el CSV entra por stdin (-T), no se monta ni se copia a la imagen.
docker compose -f docker-compose.prod.yml --profile tools run --rm -T \
  migrate npx tsx prisma/import-whitelist.ts - < ~/whitelist.csv

# Borrar el CSV del servidor en cuanto el import dice OK.
shred -u ~/whitelist.csv
```

El import valida el CSV **completo** antes de tocar la base y hace DELETE +
INSERT por lotes de 5.000 + registro en `whitelist_imports`, todo en una
transacción (~20 s para 304k cuentas): si algo falla, queda la lista anterior, y
mientras corre la API sigue respondiendo con la anterior. Es idempotente.
Salvaguarda: si la lista nueva tiene **menos de la mitad** de cuentas que la
vigente, aborta (CSV truncado); si es correcto, repetir con `--force`. El
backend no necesita reiniciarse.

### 10.3 Variables y verificación

| Variable | Defecto | Efecto |
|---|---|---|
| `WHITELIST_ENFORCE` | `false` | `true`: la app bloquea cuentas no listadas. `false`: solo avisa. |
| `WHITELIST_EXTRA_ACCOUNTS` | vacío | Cuentas demo (p. ej. `40123456`) que responden `listed:true, status:ACTIVO, source:EXTRA`. |

Cambiarlas exige recrear el backend (`up -d --force-recreate backend`).

```bash
curl -s https://<dominio>/herramientas/v1/accounts/35070291/whitelist \
  -H "Authorization: Bearer $TOKEN"
# {"accountNumber":"35070291","listed":true,"source":"IMPORT","status":"ACTIVO",...}

# Último import (solo conteos)
docker compose -f docker-compose.prod.yml exec postgres psql -U wifix -d wifix_tools \
  -c "select imported_at, accounts, by_status from whitelist_imports order by imported_at desc limit 3"
```

Sin ningún import la ruta responde `listed:null, reason:WHITELIST_EMPTY,
enforce:false`: la app no bloquea a nadie hasta que haya lista.

### 10.4 Nombre de respaldo en client-profile (FSM `real`)

Con `CONNECTOR_MODE_FSM=real`, `GET /accounts/{n}/client-profile` **nunca**
devuelve identidad inventada: lo que FSM no trae va `null` con
`sources.<campo>='NONE'`. Si FSM no trae nombre y la cuenta está en la
whitelist con nombre, `fullName` sale de ahí (`sources.fullName='WHITELIST'`).
Cuando FSM no devolvió identidad, la respuesta trae
`degraded:{reason:'FSM_NO_DATA', …}`. Plan y velocidad siguen del mock.

Requiere haber aplicado la migración `20260926150000_add_whitelist_full_name`
**y** haber importado un CSV v2 (con un import v1 no hay nombre de respaldo).
