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

### Fase A2 — Middleware base (Zod + paginación) · ⏳ Pendiente

### Fase A3 — Catálogos · ⏳ Pendiente

### Fase A4 — Media · ⏳ Pendiente

### Fase A5 — Herramientas · ⏳ Pendiente

### Fase A6 — Equipos retirados · ⏳ Pendiente

### Fase A7 — Historial de la cuenta · ⏳ Pendiente

### Fase A8 — Pruebas y cierre del backend · ⏳ Pendiente

---

## PARTE B — Frontend (en `wifix-webapp`)

### Fase B0 — Estudio del repo existente · ⏳ Pendiente
### Fase B1 — Capa de API (mock) · ⏳ Pendiente
### Fase B2 — Pantalla de Herramientas · ⏳ Pendiente
### Fase B3 — Pantalla de Equipos Retirados · ⏳ Pendiente
### Fase B4 — Estilos y cierre del frontend · ⏳ Pendiente

---

## PARTE C — Integración · ⏳ Pendiente
