# ---------------------------------------------------------------------------
# Wifix Certificate — backend (Node 20 + Fastify + Prisma)
#
# Tres etapas:
#   builder  npm ci completo + prisma generate + tsc  → dist/
#   tools    imagen con el CLI de Prisma y tsx: migraciones y seeds (one-shot)
#   runtime  imagen final, solo dependencias de producción, usuario no-root
#
# `engines.node` del package.json pide >=20 → node:20-alpine.
#
# Build:   docker build -t wifix-backend:demo .
# Correr:  ver docker-compose.prod.yml (no exponer 8080 al mundo: el TLS lo pone
#          el reverse proxy del VPS).
# ---------------------------------------------------------------------------

# --- builder ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma necesita openssl para resolver el engine correcto en Alpine.
RUN apk add --no-cache openssl

# Capa de dependencias: cambia solo si cambian los manifiestos.
COPY package.json package-lock.json ./
RUN npm ci

# El cliente de Prisma se genera a partir del esquema, antes de compilar.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
# `tsconfig.json` incluye `tests/**` y el conector en modo `fixture` lee los JSON
# de tests/fixtures/fsm: los tests viajan al builder a propósito.
COPY tests ./tests
RUN npm run build

# --- tools (migraciones, seeds, admin) -------------------------------------
# Misma imagen del builder: ya tiene el CLI de Prisma, tsx y el esquema.
# No corre el servidor: se usa con `docker compose run --rm migrate …`.
FROM builder AS tools
WORKDIR /app
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# --- runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=8080

# Solo dependencias de producción. El esquema se copia ANTES del install para
# que el postinstall de @prisma/client lo encuentre.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force
# El cliente generado se trae del builder en lugar de volver a generarlo: el
# build de la imagen no necesita descargar nada más.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# `tsc` emite con rootDir=. → el servidor queda en dist/src/server.js.
COPY --from=builder /app/dist ./dist
# Fixtures de FSM: los necesita CONNECTOR_MODE_FSM=fixture (cero red).
COPY tests/fixtures ./tests/fixtures

# El usuario `node` ya existe en la imagen oficial: nada corre como root.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# busybox trae wget; no hay curl en alpine. /health no exige token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/src/server.js"]
