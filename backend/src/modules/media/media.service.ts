import type { Buffer } from 'node:buffer';
import { ApiError } from '../../middleware/error-handler.js';
import { uploadObject } from '../../lib/storage.js';
import { mediaRepository } from './media.repository.js';
import { toMediaFileDto, type MediaFileDto } from './media.mappers.js';

export const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png']);
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface UploadCommand {
  body: Buffer;
  contentType: string;
}

export const mediaService = {
  async upload(cmd: UploadCommand): Promise<MediaFileDto> {
    if (!ALLOWED_CONTENT_TYPES.has(cmd.contentType)) {
      throw ApiError.validation(
        `Tipo de archivo no permitido. Use ${[...ALLOWED_CONTENT_TYPES].join(', ')}.`,
        [{ field: 'file', issue: `contentType "${cmd.contentType}" no soportado` }],
      );
    }
    if (cmd.body.length === 0) {
      throw ApiError.validation('El archivo está vacío.', [
        { field: 'file', issue: 'tamaño 0 bytes' },
      ]);
    }
    if (cmd.body.length > MAX_FILE_BYTES) {
      throw ApiError.validation(
        `El archivo excede el tamaño máximo permitido (${MAX_FILE_BYTES} bytes).`,
        [{ field: 'file', issue: `${cmd.body.length} bytes > ${MAX_FILE_BYTES}` }],
      );
    }

    const uploaded = await uploadObject({ body: cmd.body, contentType: cmd.contentType });
    const record = await mediaRepository.create({
      storageKey: uploaded.storageKey,
      url: uploaded.url,
      contentType: uploaded.contentType,
      sizeBytes: uploaded.sizeBytes,
    });
    return toMediaFileDto(record);
  },

  async getById(id: string): Promise<MediaFileDto> {
    const record = await mediaRepository.findById(id);
    if (!record) throw ApiError.mediaNotFound(`No se encontró el archivo con id ${id}.`);
    return toMediaFileDto(record);
  },
};
