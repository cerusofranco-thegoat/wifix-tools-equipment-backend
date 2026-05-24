import { ApiError } from '../../middleware/error-handler.js';
import { toContextColumns } from '../../schemas/service-context.js';
import { assertNotFuture } from '../../lib/not-future.js';
import { toPagedResponse, type PagedResponse } from '../../lib/pagination.js';
import { retiredEquipmentRepository } from './retired-equipment.repository.js';
import {
  toRetiredEquipmentDto,
  type RetiredEquipmentDto,
} from './retired-equipment.mappers.js';
import type {
  RetiredEquipmentInput,
  RetiredEquipmentFilters,
} from './retired-equipment.schemas.js';

export const retiredEquipmentService = {
  async create(input: RetiredEquipmentInput): Promise<RetiredEquipmentDto> {
    assertNotFuture(input.retiredAt, 'retiredAt');

    const model = await retiredEquipmentRepository.equipmentModelById(input.equipmentModelId);
    if (!model) {
      throw ApiError.catalogItemNotFound(
        `El modelo de equipo ${input.equipmentModelId} no existe.`,
      );
    }

    const reason = await retiredEquipmentRepository.removalReasonByCode(input.removalReasonCode);
    if (!reason) {
      throw ApiError.catalogItemNotFound(
        `El motivo de retiro ${input.removalReasonCode} no existe.`,
      );
    }

    if (input.barcodePhotoId) {
      const exists = await retiredEquipmentRepository.mediaExists(input.barcodePhotoId);
      if (!exists) {
        throw ApiError.mediaNotFound(
          `El archivo ${input.barcodePhotoId} no existe (barcodePhotoId).`,
        );
      }
    }

    const ctx = toContextColumns(input);
    const row = await retiredEquipmentRepository.create({
      ...ctx,
      equipmentModelId: input.equipmentModelId,
      serialValue: input.serialValue,
      serialFieldType: model.serialFieldType, // snapshot del modelo
      barcodePhotoId: input.barcodePhotoId ?? null,
      removalReasonCode: input.removalReasonCode,
      observations: input.observations ?? null,
      retiredAt: input.retiredAt,
    });
    return toRetiredEquipmentDto(row);
  },

  async getById(id: string): Promise<RetiredEquipmentDto> {
    const row = await retiredEquipmentRepository.findById(id);
    if (!row) throw ApiError.notFound(`No se encontró el equipo retirado con id ${id}.`);
    return toRetiredEquipmentDto(row);
  },

  async list(filters: RetiredEquipmentFilters): Promise<PagedResponse<RetiredEquipmentDto>> {
    const { items, totalItems } = await retiredEquipmentRepository.list(filters);
    return toPagedResponse(filters, totalItems, items.map(toRetiredEquipmentDto));
  },
};
