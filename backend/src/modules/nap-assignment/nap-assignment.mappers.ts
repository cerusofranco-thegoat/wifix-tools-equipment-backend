import type { NapAssignment } from '@prisma/client';

export interface NapAssignmentDto {
  id: string;
  accountNumber: string;
  napId: string | null;
  napCode: string;
  napName: string | null;
  port: number | null;
  latitude: number;
  longitude: number;
  distanceMeters: number | null;
  source: 'FSM' | 'TEC' | 'MOCK';
  taskId: string | null;
  workOrder: string | null;
  technicianId: string;
  createdAt: string;
}

export function toNapAssignmentDto(row: NapAssignment): NapAssignmentDto {
  return {
    id: row.id,
    accountNumber: row.accountNumber,
    napId: row.napId,
    napCode: row.napCode,
    napName: row.napName,
    port: row.port,
    latitude: row.latitude,
    longitude: row.longitude,
    distanceMeters: row.distanceMeters,
    source: row.source,
    taskId: row.taskId,
    workOrder: row.workOrder,
    technicianId: row.technicianId,
    createdAt: row.createdAt.toISOString(),
  };
}
