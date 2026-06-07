# Wifix · Asistencia Técnica — Registro de decisiones (ADR)

Conjunto de Architecture Decision Records del módulo. Ubicación sugerida en el repo: `docs/adr/`. Una decisión por ADR; si una se cambia más adelante, se crea uno nuevo que la reemplace.

Contexto del proyecto en todos: **Tulpa Solutions S.A.S. · Wifix · Módulo Asistencia Técnica** (cliente operadora: Xtrim / Grupo TVCable).

---

## 0001. Eje central = sesión remota intermediada (con ACS como plano complementario)

- Estado: aceptada
- Fecha: 2026-06-06
- Contexto del proyecto: Wifix / Asistencia Técnica

### Contexto
El sistema legado resolvía la asistencia exponiendo el panel web del router del cliente a una URL pública (`socket-tunnel` + `localtunnel`) embebida en un `<iframe>` del portal del Call Center. Un buen porcentaje del parque habla **TR-069/ACS**, y la app nueva ya tiene un conector ACS con lectura/escritura de configuración WiFi. Sin embargo, **Xtrim quiere que el eje central de la asistencia siga siendo la sesión remota** (el agente "entra" al equipo y lo resuelve en vivo), no únicamente acciones automatizadas.

### Decisión
La **sesión remota intermediada** es la columna vertebral del módulo: el agente del Call Center opera el equipo del cliente a través de un **broker autenticado** de Wifix, nunca por una URL pública. Las **acciones vía ACS/TR-069** (reinicio, SSID/clave, canal, reaprovisionar, diagnóstico) son un **plano complementario** ofrecido dentro de la misma consola cuando el equipo lo soporta.

### Alternativas consideradas
- **ACS primero, sesión remota como excepción** — más seguro y estándar, pero contradice el requerimiento de Xtrim y no cubre equipos sin TR-069.
- **Mantener el túnel público + iframe** — descartado: inseguro (router expuesto por HTTP, subdominio adivinable, sin auth).
- **Solo co-browsing** — menor superficie de ataque, pero el agente no opera el equipo directamente; insuficiente como eje central.

### Consecuencias
- **Gana:** alineación con Xtrim; cubre todo el parque (con o sin ACS); experiencia de resolución en vivo.
- **Cuesta:** el broker de sesión remota es la pieza de mayor riesgo y exige controles fuertes (autenticación por sesión, alcance a un solo CPE, expiración corta, auditoría y grabación opcional, consentimiento del cliente). Mayor esfuerzo de ingeniería y de seguridad que un enfoque ACS-only.

---

## 0002. Transporte de la sesión remota = reverse tunnel WSS intermediado (reemplazo de localtunnel)

- Estado: aceptada
- Fecha: 2026-06-06
- Contexto del proyecto: Wifix / Asistencia Técnica

### Contexto
El router del cliente vive detrás de NAT, sin IP pública. La app del técnico (Capacitor) sí está en el mismo LAN y puede alcanzar el panel del router (gateway, p. ej. `192.168.x.1:80`). Hay que reemplazar `socket-tunnel`/`localtunnel` por algo seguro.

### Decisión
La app del técnico abre una **conexión saliente WSS** a un **broker de Wifix**. El agente, autenticado en el portal, alcanza el panel del router **a través del broker**, que multiplexa HTTP(S) sobre el túnel del técnico, **con alcance a esa sola sesión y CPE**, token de corta duración y auto-cierre al pausar la app (comportamiento que el legado ya tenía y se conserva).

### Alternativas consideradas
- **`socket-tunnel`/`localtunnel` público** — descartado por seguridad.
- **Túnel directo del agente al CPE** — imposible por NAT/CGNAT.
- **VPN por equipo** — pesado de operar a escala.

### Consecuencias
- **Gana:** sin exposición pública del router; sesiones acotadas y auditables; atraviesa NAT por conexión saliente del técnico.
- **Cuesta:** hay que construir y operar el broker (un reverse-proxy autenticado y multiplexado); el protocolo de trama del túnel se define en la Fase D.

---

## 0003. Stack del portal del Call Center = React + TypeScript + Vite

- Estado: aceptada
- Fecha: 2026-06-06
- Contexto del proyecto: Wifix / Asistencia Técnica

### Contexto
El portal legado es Angular 7 + CoreUI (2018-2019), desactualizado. La app nueva del técnico es Capacitor + HTML/CSS/JS vanilla; el portal es una herramienta de escritorio rica y distinta.

### Decisión
El nuevo portal del Call Center se construye en **React + TypeScript + Vite**, consumiendo la **misma API Fastify y el WebSocket** del backend de Wifix.

### Alternativas consideradas
- **Next.js** — SSR/routing que el portal interno no necesita; más complejidad.
- **Angular moderno** — continuidad con el legado, pero curva y peso mayores; el equipo va hacia React.

### Consecuencias
- **Gana:** desarrollo ágil, ecosistema amplio, build rápido, un solo backend para técnico y portal.
- **Cuesta:** dos paradigmas de frontend conviven (vanilla en la app del técnico, React en el portal); aceptable porque son superficies y públicos distintos.

---

## 0004. Video/voz = Jitsi self-host moderno

- Estado: aceptada
- Fecha: 2026-06-06
- Contexto del proyecto: Wifix / Asistencia Técnica

### Contexto
El legado usaba Jitsi (plugin Cordova) para el video técnico ↔ agente. Hay que modernizarlo.

### Decisión
Se usa **Jitsi Meet self-host (versión moderna)** para el canal de video/voz, con salas por sesión y JWT de sala emitido por el backend de Wifix.

### Alternativas consideradas
- **SFU gestionado (LiveKit / Daily)** — menos operación, pero costo recurrente por uso y lock-in.
- **Jitsi self-host** — control total y costo de infraestructura propio (Hetzner), a cambio de operarlo.

### Consecuencias
- **Gana:** control, sin costo por minuto, datos en infraestructura propia.
- **Cuesta:** operar el servidor Jitsi (JVB, escalado, TURN). Se asume sobre Hetzner/Dokploy.

---

## 0005. Plegar Proxy Xtrim al backend; retirar el servicio NestJS

- Estado: aceptada
- Fecha: 2026-06-06
- Contexto del proyecto: Wifix / Asistencia Técnica

### Contexto
Proxy Xtrim (NestJS) es un gateway HTTP con auditoría a los backends de la operadora. Su único valor propio es **auth + logging**, ya replicables por la capa de conectores + una tabla de auditoría.

### Decisión
Las operaciones del catálogo de Proxy Xtrim se incorporan como **conectores** del backend de Wifix (ticketing, scheduling, extensión de `fsm` e `ispmonitor`, mapeo a `comarch`), y la auditoría va a una tabla **`ConnectorCallLog`**. El servicio NestJS separado **se retira**.

### Alternativas consideradas
- **Mantener Proxy Xtrim separado** — duplica auth/secretos/auditoría y suma una superficie y un despliegue extra.

### Consecuencias
- **Gana:** un solo punto de autenticación, secretos y auditoría; menos servicios que operar.
- **Cuesta:** migrar el catálogo y las credenciales reales de la operadora a variables de entorno por conector; coordinar el corte con quien hoy consume el proxy.

---

## 0006. Backend "mirror" de Wifi Monitor — retirar servicio; importar histórico una sola vez si aplica

- Estado: aceptada
- Fecha: 2026-06-06
- Contexto del proyecto: Wifix / Asistencia Técnica

### Contexto
Wifi Monitor envía cada estudio (fire-and-forget) a un backend nuevo en Next.js 15 + Prisma 6 con un modelo `Scan` plano. El backend de Wifix ya captura ese diagnóstico con un esquema más rico (mapa de calor multi-AP, speedtest, pings, dispositivos), por lo que el `Scan` queda subsumido.

### Decisión
**No se mantiene el mirror como servicio en producción** (es redundante con Wifix). Si el mirror ya acumuló un volumen real de estudios de producción, se hace una **importación única (ETL)** de ese histórico a una tabla de archivo `LegacyScan` en Wifix (métricas + payload crudo, indexada por `accountNumber`). Si no hay volumen significativo, se descarta por completo.

### Alternativas consideradas
- **Consolidar el mirror activo dentro de Wifix** — innecesario: la app nueva ya genera datos más ricos por sus propias herramientas.
- **Dejar el mirror corriendo en paralelo** — mantiene dos modelos de datos divergentes.

### Consecuencias
- **Gana:** un solo modelo de datos vivo; se preserva el histórico útil sin dependencia continua.
- **Cuesta:** un trabajo puntual de ETL y mapeo si se decide importar.
