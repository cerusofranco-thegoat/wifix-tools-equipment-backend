/**
 * Interfaz del store de tokens de sesión remota de un solo uso.
 *
 * Cada implementación debe garantizar que `reserve` es atómica:
 * solo el primer llamador que llame `reserve(jti)` sobre un jti no usado
 * obtendrá `true`; todos los demás obtendrán `false`. Esto cierra la
 * ventana TOCTOU entre el check y el set.
 *
 * Implementaciones:
 *   - InMemoryTokenStore (default): Map en proceso, síncrona, instancia única.
 *   - RedisTokenStore: SET NX EX en Redis, atómica cross-instancia.
 *
 * La factory (`broker.token-store.factory.ts`) elige la impl según REDIS_URL.
 */

export interface BrokerTokenEntry {
  jti: string;
  remoteSessionId: string;
  sessionId: string;
  targetHost: string | null;
  agentId: string;
  expiresAt: number; // epoch ms
  used: boolean;
}

export type ConsumeResult =
  | { ok: true; entry: BrokerTokenEntry }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_USED' | 'EXPIRED' };

export interface TokenStore {
  /**
   * Registra un token recién emitido.
   * En Redis almacena los metadatos con TTL basado en expiresAt.
   */
  register(entry: BrokerTokenEntry): Promise<void>;

  /**
   * Reserva el jti de forma atómica (uso único).
   * - InMemory: check-and-set síncrono sobre el Map (envuelto en Promise).
   * - Redis: SET jti "reserved" NX EX <ttl> → OK = true / nil = false.
   *
   * Devuelve true si la reserva tuvo éxito (primer uso); false si el token
   * ya fue reservado, no existe, o expiró.
   */
  reserve(jti: string): Promise<boolean>;

  /**
   * Libera una reserva realizada por `reserve` en caso de que la verificación
   * posterior (firma JWT, expiración) haya fallado. Permite que el token siga
   * siendo usable (p.ej. si el JWT estaba malformado y era de un atacante).
   *
   * Nota: en Redis esto no es posible sin una operación extra; dado que el SET NX
   * ya marcó la clave, el release restaura el campo `used: false` en los metadatos
   * sin liberar la clave principal de reserva (el atacante ya "quemó" la ventana
   * atómica, pero el token legítimo puede rehacerse vía flujo de error).
   * En la práctica release solo se llama cuando el JWT falla verificación de firma,
   * lo que implica que el token es inválido de todas formas; no se espera que un
   * token legítimo necesite release en Redis.
   */
  release(jti: string): Promise<void>;

  /**
   * Consume el token identificado por `jti` de forma no atómica.
   * Equivale a reserve + devolver la entrada si existe.
   * Se usa internamente para inspección; en flujos críticos usar `reserve`.
   */
  consume(jti: string): Promise<ConsumeResult>;

  /**
   * Devuelve la entrada sin consumirla (para tests/internos).
   * Puede devolver undefined si el token expiró en Redis (TTL natural).
   */
  peek(jti: string): Promise<BrokerTokenEntry | undefined>;

  /**
   * Elimina un token del store (para limpiar tras cerrar la sesión remota).
   */
  revoke(jti: string): Promise<void>;

  /**
   * Elimina todas las entradas expiradas o ya usadas.
   * En Redis la expiración es automática (EX del SET); purge es un no-op o
   * limpia el índice auxiliar si existe.
   */
  purge(): Promise<number>;

  /**
   * Limpia todo el store (solo para tests).
   */
  clear(): Promise<void>;

  /**
   * Número de entradas actuales (para tests/observabilidad).
   * En Redis puede ser una aproximación si se usa scan.
   */
  size(): Promise<number>;
}
