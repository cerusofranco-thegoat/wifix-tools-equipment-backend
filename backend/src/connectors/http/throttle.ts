// ---------------------------------------------------------------------------
// Control de caudal hacia la API de operadora.
//
// La operadora confirmó (2026-08-27) que no hay un tope de peticiones por
// credencial, pero pidió expresamente no consultar de más: "el sistema no tiene
// recursos infinitos" y toda consulta va contra PRODUCCIÓN, no hay ambiente de
// pruebas. Con varios técnicos en campo a la vez, tres piezas evitan el abuso:
//
//   1. dedupe — dos consultas idénticas simultáneas comparten una sola petición
//      (dos técnicos mirando el mismo equipo, o un doble tap en "Consultar");
//   2. cache con TTL corto — repetir la misma consulta dentro de la ventana no
//      vuelve a salir a la red;
//   3. semáforo de concurrencia — nunca más de N peticiones en vuelo, el resto
//      espera en cola en vez de salir en ráfaga.
// ---------------------------------------------------------------------------

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/** Tope de entradas del cache; al superarlo se barren las vencidas. */
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Si aun así sigue lleno, se descartan las más viejas (Map preserva inserción).
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Ejecuta `loader` deduplicando peticiones en vuelo y cacheando el resultado
 * `ttlMs` milisegundos. Los errores NO se cachean: un fallo puntual no debe
 * dejar al técnico sin datos hasta que venza la entrada.
 */
export function cachedFetch<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value as T);

  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const promise = loader()
    .then((value) => {
      if (ttlMs > 0) {
        cache.set(key, { expiresAt: Date.now() + ttlMs, value });
        if (cache.size > MAX_CACHE_ENTRIES) prune(Date.now());
      }
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Semáforo: como mucho `max` tareas a la vez, el resto en cola FIFO. */
export function createLimiter(max: number): Limiter {
  const slots = Math.max(1, Math.floor(max));
  const queue: Array<() => void> = [];
  let active = 0;

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= slots) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/** Vacía cache y peticiones en vuelo (pruebas, o cambio de credenciales). */
export function resetHttpCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Estado del cache, para logs y diagnóstico. */
export function httpCacheStats(): { entries: number; inFlight: number } {
  return { entries: cache.size, inFlight: inFlight.size };
}
