import { ApiError } from '../../../middleware/error-handler.js';
import { accessPointsRepository } from './access-points.repository.js';
import { toAccessPointDto, type WifiAccessPointDto } from './access-points.mappers.js';
import type { WifiAccessPointInput, WifiAccessPointUpdate } from './access-points.schemas.js';

export const accessPointsService = {
  async listByAccount(accountNumber: string): Promise<WifiAccessPointDto[]> {
    const rows = await accessPointsRepository.listByAccount(accountNumber);
    return rows.map(toAccessPointDto);
  },

  async upsertForAccount(
    accountNumber: string,
    input: WifiAccessPointInput,
  ): Promise<{ dto: WifiAccessPointDto; created: boolean }> {
    const { row, created } = await accessPointsRepository.upsertForAccount(accountNumber, input);
    return { dto: toAccessPointDto(row), created };
  },

  async update(id: string, patch: WifiAccessPointUpdate): Promise<WifiAccessPointDto> {
    const existing = await accessPointsRepository.findById(id);
    if (!existing) throw ApiError.notFound(`No se encontró el AP con id ${id}.`);
    const row = await accessPointsRepository.update(id, patch);
    return toAccessPointDto(row);
  },
};
