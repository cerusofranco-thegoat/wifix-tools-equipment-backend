import { catalogsRepository } from './catalogs.repository.js';
import {
  toEquipmentModelDto,
  toRemovalReasonDto,
  toSpeedtestServerDto,
  toNetworkServerDto,
  type EquipmentModelDto,
  type RemovalReasonDto,
  type SpeedtestServerDto,
  type NetworkServerDto,
} from './catalogs.mappers.js';

export const catalogsService = {
  async listEquipmentModels(): Promise<EquipmentModelDto[]> {
    const items = await catalogsRepository.listEquipmentModels();
    return items.map(toEquipmentModelDto);
  },

  async listRemovalReasons(): Promise<RemovalReasonDto[]> {
    const items = await catalogsRepository.listRemovalReasons();
    return items.map(toRemovalReasonDto);
  },

  async listSpeedtestServers(): Promise<SpeedtestServerDto[]> {
    const items = await catalogsRepository.listSpeedtestServers();
    return items.map(toSpeedtestServerDto);
  },

  async listNetworkServers(): Promise<NetworkServerDto[]> {
    const items = await catalogsRepository.listNetworkServers();
    return items.map(toNetworkServerDto);
  },
};
