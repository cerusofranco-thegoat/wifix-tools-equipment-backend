import type { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ApiError } from '../../middleware/error-handler.js';
import { parseParams } from '../../lib/validation.js';
import { uuidParamSchema } from '../../schemas/common.js';
import { MAX_FILE_BYTES, mediaService } from './media.service.js';

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_FILE_BYTES,
      files: 1,
    },
  });

  app.post('/media', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      throw ApiError.validation('Se requiere un archivo en el campo "file".', [
        { field: 'file', issue: 'requerido' },
      ]);
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'desconocido';
      if (msg.toLowerCase().includes('size limit')) {
        throw ApiError.validation(
          `El archivo excede el tamaño máximo permitido (${MAX_FILE_BYTES} bytes).`,
          [{ field: 'file', issue: 'tamaño excedido' }],
        );
      }
      throw ApiError.validation('No se pudo leer el archivo subido.', [
        { field: 'file', issue: msg },
      ]);
    }

    const dto = await mediaService.upload({ body: buffer, contentType: file.mimetype });
    return reply.code(201).send(dto);
  });

  app.get('/media/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    return mediaService.getById(id);
  });
}
