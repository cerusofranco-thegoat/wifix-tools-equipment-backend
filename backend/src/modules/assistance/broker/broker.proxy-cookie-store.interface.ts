/**
 * Interfaz del store de cookies de proxy HTTP.
 *
 * Gestiona el ciclo de vida de las cookies de sesión de proxy emitidas
 * al abrir una RemoteSession. El valor de cada cookie es un UUID opaco
 * que identifica la entrada en este store.
 *
 * Implementaciones:
 *   - InMemoryProxyCookieStore (default): Map en proceso, instancia única.
 *   - RedisProxyCookieStore: claves con TTL en Redis, atómica cross-instancia.
 *
 * La factory (`broker.proxy-cookie-store.factory.ts`) elige la impl según REDIS_URL.
 */

export interface ProxyCookieEntry {
  /** Valor opaco de la cookie (UUID v4 aleatorio). */
  cookieValue: string;
  /** ID de la RemoteSession en BD. */
  remoteSessionId: string;
  /** ID de la AssistanceSession padre. */
  sessionId: string;
  /** ID del agente propietario. */
  agentId: string;
  /**
   * targetHost del CPE — INMUTABLE desde la apertura de la RemoteSession.
   * El agente nunca puede cambiarlo por URL ni por header.
   */
  targetHost: string;
  /** Expiración como epoch ms (igual que RemoteSession.expiresAt). */
  expiresAt: number;
}

export interface ProxyCookieStore {
  /**
   * Emite un valor de cookie opaco y lo registra en el store.
   * Devuelve el valor opaco para incluirlo en el Set-Cookie header.
   *
   * En Redis almacena la entrada serializada con TTL calculado desde expiresAt.
   */
  issue(entry: Omit<ProxyCookieEntry, 'cookieValue'>): Promise<string>;

  /**
   * Busca la entrada de cookie de proxy por valor opaco.
   * Devuelve undefined si no existe o si ya expiró.
   */
  lookup(cookieValue: string): Promise<ProxyCookieEntry | undefined>;

  /**
   * Invalida la cookie de proxy asociada a una RemoteSession (por remoteSessionId).
   * Se llama al cerrar o expirar la RemoteSession.
   *
   * En Redis: requiere un índice auxiliar (Set) que mapea remoteSessionId → cookieValues.
   */
  invalidateBySession(remoteSessionId: string): Promise<void>;

  /**
   * Invalida una cookie de proxy por su valor opaco.
   */
  invalidate(cookieValue: string): Promise<void>;

  /**
   * Elimina entradas expiradas (safety net).
   * En Redis la expiración es automática; purge puede ser un no-op o limpiar
   * el índice auxiliar.
   */
  purge(): Promise<number>;

  /**
   * Limpia todo el store (solo para tests).
   */
  clear(): Promise<void>;

  /**
   * Número de entradas actuales (para tests/observabilidad).
   */
  size(): Promise<number>;

  /**
   * Devuelve la entrada sin expirarla (solo para tests).
   */
  peek(cookieValue: string): Promise<ProxyCookieEntry | undefined>;
}
