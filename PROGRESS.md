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

### Fase A1 — Modelo de datos (Prisma) · ⏳ Pendiente

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
