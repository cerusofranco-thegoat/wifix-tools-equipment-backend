// Utilidades compartidas por los conectores mock.
// Genera datos deterministas a partir de una clave (accountNumber, napCode):
// cada vez que se llama con la misma clave, devuelve los mismos valores.

import { ApiError } from '../middleware/error-handler.js';

/** Código de estado de cuenta tal cual lo publica la operadora (FSM). */
export type AccountStatusCode = 'A' | 'S' | 'T' | 'O' | 'P';

/** Estado de cuenta en el modelo interno. */
export type AccountStatusName =
  | 'ACTIVA'
  | 'SUSPENDIDA'
  | 'TERMINADA'
  | 'ORDENADA'
  | 'PENDIENTE'
  | 'DESCONOCIDA';

export type DegradedReason = 'FSM_AUTH' | 'FSM_UNAVAILABLE' | 'SOURCE_FALLBACK' | 'TRUNCATED';

/**
 * Aviso de respuesta servida con una fuente alternativa o incompleta. NO es un
 * error: la respuesta es 200 y el frontend solo pinta un aviso. Es opcional:
 * ausente cuando todo salió bien.
 */
export interface Degraded {
  reason: DegradedReason;
  /** Texto en español, listo para mostrar al técnico. */
  message: string;
}

/** Hash xmur3 (32-bit) sobre un string. Sin dependencias. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** PRNG mulberry32 — period ~2^32, suficiente para datos demo. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeededRng {
  /** Float en [0, 1). */
  next(): number;
  /** Entero en [min, max]. */
  intBetween(min: number, max: number): number;
  /** Float en [min, max] con `decimals` decimales. */
  floatBetween(min: number, max: number, decimals?: number): number;
  /** Bool con probabilidad `pTrue`. */
  bool(pTrue?: number): boolean;
  /** Elige un elemento de la lista. */
  pick<T>(list: readonly T[]): T;
  /** Devuelve `n` elementos distintos de la lista. */
  sample<T>(list: readonly T[], n: number): T[];
}

export function seededRng(seed: string): SeededRng {
  const seedFn = xmur3(seed);
  const next = mulberry32(seedFn());
  return {
    next,
    intBetween(min, max) {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    floatBetween(min, max, decimals = 2) {
      const v = next() * (max - min) + min;
      const f = Math.pow(10, decimals);
      return Math.round(v * f) / f;
    },
    bool(pTrue = 0.5) {
      return next() < pTrue;
    },
    pick<T>(list: readonly T[]): T {
      if (list.length === 0) {
        throw new Error('seededRng.pick: lista vacía.');
      }
      return list[Math.floor(next() * list.length)] as T;
    },
    sample<T>(list: readonly T[], n: number): T[] {
      const pool = [...list];
      const out: T[] = [];
      for (let i = 0; i < n && pool.length > 0; i++) {
        const idx = Math.floor(next() * pool.length);
        out.push(pool.splice(idx, 1)[0] as T);
      }
      return out;
    },
  };
}

/** Stub para conectores reales: indica que aún no están implementados. */
export function notImplemented(operation: string): never {
  throw ApiError.connectorError(
    `Conector real no implementado todavía: ${operation}. ` +
      `Cuando se entreguen credenciales y endpoints se reemplaza este esqueleto.`,
  );
}
