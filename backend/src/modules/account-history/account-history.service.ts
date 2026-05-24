import { prisma } from '../../db/prisma.js';
import { toDistanceDto } from '../tools/distance/distance.mappers.js';
import { toSpeedtestDto } from '../tools/speedtest/speedtest.mappers.js';
import { toHeatmapDto } from '../tools/heatmap/heatmap.mappers.js';
import { toPingDto } from '../tools/ping/ping.mappers.js';
import { toTracerouteDto } from '../tools/traceroute/traceroute.mappers.js';
import { toRetiredEquipmentDto } from '../retired-equipment/retired-equipment.mappers.js';

export interface AccountHistoryQuery {
  accountNumber: string;
  dateFrom?: Date;
  dateTo?: Date;
}

function buildDateRange(q: AccountHistoryQuery): { gte?: Date; lte?: Date } | undefined {
  if (!q.dateFrom && !q.dateTo) return undefined;
  const r: { gte?: Date; lte?: Date } = {};
  if (q.dateFrom) r.gte = q.dateFrom;
  if (q.dateTo) r.lte = q.dateTo;
  return r;
}

export const accountHistoryService = {
  async get(q: AccountHistoryQuery) {
    const dateRange = buildDateRange(q);
    const measuredFilter = dateRange ? { measuredAt: dateRange } : {};
    const createdFilter = dateRange ? { createdAt: dateRange } : {};
    const retiredFilter = dateRange ? { retiredAt: dateRange } : {};

    const [distance, speedtests, heatmaps, pings, traceroutes, retired] = await Promise.all([
      prisma.distanceMeasurement.findMany({
        where: { accountNumber: q.accountNumber, ...measuredFilter },
        orderBy: { measuredAt: 'desc' },
      }),
      prisma.speedtest.findMany({
        where: { accountNumber: q.accountNumber, ...measuredFilter },
        orderBy: { measuredAt: 'desc' },
      }),
      prisma.wifiHeatmap.findMany({
        where: { accountNumber: q.accountNumber, ...createdFilter },
        orderBy: { createdAt: 'desc' },
        include: { rooms: true },
      }),
      prisma.pingTest.findMany({
        where: { accountNumber: q.accountNumber, ...measuredFilter },
        orderBy: { measuredAt: 'desc' },
      }),
      prisma.tracerouteTest.findMany({
        where: { accountNumber: q.accountNumber, ...measuredFilter },
        orderBy: { measuredAt: 'desc' },
        include: { hops: true },
      }),
      prisma.retiredEquipment.findMany({
        where: { accountNumber: q.accountNumber, ...retiredFilter },
        orderBy: { retiredAt: 'desc' },
        include: { barcodePhoto: true },
      }),
    ]);

    return {
      accountNumber: q.accountNumber,
      distanceMeasurements: distance.map(toDistanceDto),
      speedtests: speedtests.map(toSpeedtestDto),
      wifiHeatmaps: heatmaps.map(toHeatmapDto),
      pingTests: pings.map(toPingDto),
      tracerouteTests: traceroutes.map(toTracerouteDto),
      retiredEquipment: retired.map(toRetiredEquipmentDto),
    };
  },
};
