import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { TextEncoder } from 'node:util';
import { env } from '../config/env.js';
import { ApiError } from '../middleware/error-handler.js';

const encoder = new TextEncoder();

function secretKey(): Uint8Array {
  return encoder.encode(env.JWT_SECRET);
}

export type UserRole = 'TECHNICIAN' | 'AGENT' | 'SUPERVISOR';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
}

export async function signAuthToken(payload: AuthTokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, name: payload.name, role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRES_IN)
    .sign(secretKey());
}

export async function verifyAuthToken(token: string): Promise<AuthTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    if (!payload.sub) throw ApiError.unauthorized('Token sin sujeto.');
    const email = typeof payload.email === 'string' ? payload.email : '';
    const name = typeof payload.name === 'string' ? payload.name : '';
    const role: UserRole =
      payload.role === 'AGENT' || payload.role === 'SUPERVISOR' ? payload.role : 'TECHNICIAN';
    return { sub: payload.sub, email, name, role };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (
      err instanceof joseErrors.JWTExpired ||
      err instanceof joseErrors.JWTInvalid ||
      err instanceof joseErrors.JWSSignatureVerificationFailed ||
      err instanceof joseErrors.JWSInvalid
    ) {
      throw ApiError.unauthorized('Token inválido o expirado.');
    }
    throw ApiError.unauthorized('No se pudo verificar el token.');
  }
}
