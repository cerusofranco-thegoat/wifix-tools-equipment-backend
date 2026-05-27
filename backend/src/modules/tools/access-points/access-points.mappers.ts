import type { WifiAccessPoint } from '@prisma/client';

export interface WifiAccessPointDto {
  id: string;
  accountNumber: string;
  bssid: string;
  ssid?: string;
  label: string;
  apType: string;
  band: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export function toAccessPointDto(row: WifiAccessPoint): WifiAccessPointDto {
  const dto: WifiAccessPointDto = {
    id: row.id,
    accountNumber: row.accountNumber,
    bssid: row.bssid,
    label: row.label,
    apType: row.apType,
    band: row.band,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.ssid) dto.ssid = row.ssid;
  if (row.notes) dto.notes = row.notes;
  return dto;
}
