import type { RetiredEquipment, MediaFile } from '@prisma/client';
import { toContextDto, type ContextDto } from '../../schemas/service-context.js';
import { serialFieldTypeToContract } from '../catalogs/catalogs.mappers.js';

export interface RetiredEquipmentDto extends ContextDto {
  id: string;
  createdAt: string;
  equipmentModelId: string;
  serialValue: string;
  serialFieldType: string;
  barcodePhotoId?: string;
  barcodePhotoUrl?: string;
  removalReasonCode: string;
  observations?: string;
  retiredAt: string;
}

export function toRetiredEquipmentDto(
  row: RetiredEquipment & { barcodePhoto?: MediaFile | null },
): RetiredEquipmentDto {
  const dto: RetiredEquipmentDto = {
    ...toContextDto(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    equipmentModelId: row.equipmentModelId,
    serialValue: row.serialValue,
    serialFieldType: serialFieldTypeToContract(row.serialFieldType),
    removalReasonCode: row.removalReasonCode,
    retiredAt: row.retiredAt.toISOString(),
  };
  if (row.barcodePhotoId) dto.barcodePhotoId = row.barcodePhotoId;
  if (row.barcodePhoto?.url) dto.barcodePhotoUrl = row.barcodePhoto.url;
  if (row.observations) dto.observations = row.observations;
  return dto;
}
