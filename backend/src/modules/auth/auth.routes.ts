import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../lib/validation.js';
import { loginInputSchema } from './auth.schemas.js';
import { authService } from './auth.service.js';
import { getAuthUser } from '../../middleware/authenticate.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = parseBody(loginInputSchema, request.body);
    const result = await authService.login(body);
    return reply.code(200).send(result);
  });

  app.get('/auth/me', async (request) => {
    const user = getAuthUser(request);
    return authService.getById(user.id);
  });
}
