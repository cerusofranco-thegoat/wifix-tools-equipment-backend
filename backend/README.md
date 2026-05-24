# Wifix — Backend de Herramientas y Equipos Retirados

Servicio backend de la Fase 1 del módulo de Herramientas y Equipos Retirados
de la app Wifix. Persiste los resultados de mediciones de campo y los
registros de equipos retirados, y expone la API descrita en
`../openapi-herramientas-equipos.yaml`.

## Stack

- Node.js 20 LTS · TypeScript (`strict`)
- Fastify · Zod · Prisma · PostgreSQL 15
- Almacenamiento S3-compatible (MinIO en local)
- pino · Vitest + Supertest

## Requisitos

- Node.js 20 LTS o superior
- Docker + Docker Compose (para PostgreSQL y MinIO en local)

## Puesta en marcha (local)

```bash
# 1. Instalar dependencias
npm install

# 2. Copiar variables de entorno
cp .env.example .env

# 3. Levantar PostgreSQL y MinIO
docker compose up -d

# 4. Iniciar el servidor en modo desarrollo
npm run dev
```

El servidor queda escuchando en `http://localhost:8080`. Verificación:

```bash
curl http://localhost:8080/health
# → { "status": "ok", "service": "...", "timestamp": "..." }
```

La API del contrato se sirve bajo el prefijo `/herramientas/v1`.

## Scripts

| Script | Descripción |
|--------|-------------|
| `npm run dev` | Arranca el servidor con recarga en caliente (tsx). |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm start` | Arranca el servidor compilado. |
| `npm run lint` | Corre ESLint. |
| `npm test` | Corre la suite de pruebas con Vitest. |
| `npm run prisma:migrate` | Aplica migraciones de Prisma (fase A1). |
| `npm run prisma:seed` | Siembra los catálogos (fase A1). |

## Estructura

Ver `SPEC.md`, sección 6. Cada módulo de negocio se organiza en capas
`routes → service → repository`.
