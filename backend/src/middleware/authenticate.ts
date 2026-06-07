import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './error-handler.js';
import { verifyAuthToken, type UserRole } from '../auth/jwt.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

function extractToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

export interface AuthenticateOptions {
  excludePaths: Array<string | RegExp>;
}

export async function registerAuthenticate(
  app: FastifyInstance,
  { excludePaths }: AuthenticateOptions,
): Promise<void> {
  app.addHook('onRequest', async (request) => {
    const url = request.url.split('?')[0] ?? request.url;
    for (const exclude of excludePaths) {
      if (typeof exclude === 'string' ? url === exclude : exclude.test(url)) {
        return;
      }
    }

    const rawAuth = request.headers.authorization;
    const token = extractToken(rawAuth);
    if (!token) {
      throw ApiError.unauthorized('Falta el header Authorization Bearer.');
    }
    const payload = await verifyAuthToken(token);
    request.authUser = { id: payload.sub, email: payload.email, name: payload.name, role: payload.role };
  });
}

export function getAuthUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) {
    throw ApiError.unauthorized('No autenticado.');
  }
  return request.authUser;
}

/**
 * Guard de rol (RBAC). Lanza ApiError.forbidden si el usuario autenticado no
 * tiene ninguno de los roles indicados. Debe llamarse dentro de un handler,
 * después de que el middleware de auth haya corrido.
 */
export function requireRole(request: FastifyRequest, ...roles: UserRole[]): AuthUser {
  const user = getAuthUser(request);
  if (!roles.includes(user.role)) {
    throw ApiError.forbidden(
      `Esta operación requiere uno de los siguientes roles: ${roles.join(', ')}.`,
    );
  }
  return user;
}
