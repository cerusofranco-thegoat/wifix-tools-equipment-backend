import { prisma } from '../../../db/prisma.js';
import type { WifiAccessPointInput, WifiAccessPointUpdate } from './access-points.schemas.js';

export const accessPointsRepository = {
  listByAccount: (accountNumber: string) =>
    prisma.wifiAccessPoint.findMany({
      where: { accountNumber },
      orderBy: { createdAt: 'asc' },
    }),

  // Upsert por (accountNumber, bssid): si ya existe lo actualiza con el
  // último label/apType/band del técnico; si no, lo crea.
  upsertForAccount: async (accountNumber: string, input: WifiAccessPointInput) => {
    const existing = await prisma.wifiAccessPoint.findUnique({
      where: { accountNumber_bssid: { accountNumber, bssid: input.bssid } },
    });
    if (existing) {
      const updated = await prisma.wifiAccessPoint.update({
        where: { id: existing.id },
        data: {
          ssid: input.ssid ?? existing.ssid,
          label: input.label,
          apType: input.apType,
          band: input.band,
          notes: input.notes ?? existing.notes,
        },
      });
      return { row: updated, created: false as const };
    }
    const created = await prisma.wifiAccessPoint.create({
      data: {
        accountNumber,
        bssid: input.bssid,
        ssid: input.ssid ?? null,
        label: input.label,
        apType: input.apType,
        band: input.band,
        notes: input.notes ?? null,
      },
    });
    return { row: created, created: true as const };
  },

  findById: (id: string) => prisma.wifiAccessPoint.findUnique({ where: { id } }),

  update: (id: string, patch: WifiAccessPointUpdate) =>
    prisma.wifiAccessPoint.update({
      where: { id },
      data: {
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.apType !== undefined ? { apType: patch.apType } : {}),
        ...(patch.band !== undefined ? { band: patch.band } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      },
    }),
};
