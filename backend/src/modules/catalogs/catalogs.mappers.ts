// Mapea entidades de Prisma a los DTOs del contrato OpenAPI.
// El motivo principal es traducir los nombres de valores de enum donde
// Prisma no permite guiones (HOST_SN ↔ HOST-SN, etc.).
import type {
  EquipmentModel as PrismaEquipmentModel,
  RemovalReason as PrismaRemovalReason,
  SpeedtestServer as PrismaSpeedtestServer,
  NetworkServer as PrismaNetworkServer,
  EquipmentSerialFieldType as PrismaSerialFieldType,
} from '@prisma/client';

const SERIAL_FIELD_TYPE_TO_CONTRACT: Record<PrismaSerialFieldType, string> = {
  SN: 'SN',
  HOST_SN: 'HOST-SN',
  PON_SN: 'PON-SN',
  GPON_SN: 'GPON-SN',
  D_SN: 'D-SN',
};

const SERIAL_FIELD_TYPE_FROM_CONTRACT: Record<string, PrismaSerialFieldType> = {
  SN: 'SN',
  'HOST-SN': 'HOST_SN',
  'PON-SN': 'PON_SN',
  'GPON-SN': 'GPON_SN',
  'D-SN': 'D_SN',
};

export function serialFieldTypeToContract(value: PrismaSerialFieldType): string {
  return SERIAL_FIELD_TYPE_TO_CONTRACT[value];
}

export function serialFieldTypeFromContract(value: string): PrismaSerialFieldType | undefined {
  return SERIAL_FIELD_TYPE_FROM_CONTRACT[value];
}

export interface EquipmentModelDto {
  id: string;
  name: string;
  category: string;
  serialFieldType: string;
  brand: string | null;
  active: boolean;
}

export function toEquipmentModelDto(m: PrismaEquipmentModel): EquipmentModelDto {
  return {
    id: m.id,
    name: m.name,
    category: m.category,
    serialFieldType: serialFieldTypeToContract(m.serialFieldType),
    brand: m.brand,
    active: m.active,
  };
}

export interface RemovalReasonDto {
  code: string;
  label: string;
  active: boolean;
}

export function toRemovalReasonDto(r: PrismaRemovalReason): RemovalReasonDto {
  return { code: r.code, label: r.label, active: r.active };
}

export interface SpeedtestServerDto {
  id: string;
  name: string;
  host: string;
  city: string | null;
  location?: { latitude: number; longitude: number };
  active: boolean;
}

export function toSpeedtestServerDto(s: PrismaSpeedtestServer): SpeedtestServerDto {
  const dto: SpeedtestServerDto = {
    id: s.id,
    name: s.name,
    host: s.host,
    city: s.city,
    active: s.active,
  };
  if (s.latitude !== null && s.longitude !== null) {
    dto.location = { latitude: s.latitude, longitude: s.longitude };
  }
  return dto;
}

export interface NetworkServerDto {
  id: string;
  name: string;
  target: string;
  type: string;
  active: boolean;
}

export function toNetworkServerDto(n: PrismaNetworkServer): NetworkServerDto {
  return { id: n.id, name: n.name, target: n.target, type: n.type, active: n.active };
}
