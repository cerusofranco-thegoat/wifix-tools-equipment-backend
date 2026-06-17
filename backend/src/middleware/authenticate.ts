import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './error-handler.js';
import { verifyAuthToken } from '../auth/jwt.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
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
    request.authUser = { id: payload.sub, email: payload.email, name: payload.name };
  });
}

export function getAuthUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) {
    throw ApiError.unauthorized('No autenticado.');
  }
  return request.authUser;
}
