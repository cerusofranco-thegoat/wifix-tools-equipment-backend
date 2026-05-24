// Seed de catálogos — Fase A1.
// Idempotente: usa upsert para que correrlo varias veces no rompa.
import {
  PrismaClient,
  EquipmentCategory,
  EquipmentSerialFieldType,
  RemovalReasonCode,
  NetworkServerType,
} from '@prisma/client';

const prisma = new PrismaClient();

interface EquipmentModelSeed {
  name: string;
  category: EquipmentCategory;
  serialFieldType: EquipmentSerialFieldType;
  brand?: string;
}

const equipmentModels: EquipmentModelSeed[] = [
  { name: 'Decodificadores', category: 'DECODIFICADOR', serialFieldType: 'SN' },
  { name: 'Decodificadores HD', category: 'DECODIFICADOR_HD', serialFieldType: 'HOST_SN' },
  { name: 'MTA', category: 'MTA', serialFieldType: 'SN' },
  { name: 'ONU300G', category: 'ONU', serialFieldType: 'PON_SN' },
  { name: 'ONU HUR', category: 'ONU', serialFieldType: 'PON_SN' },
  { name: 'ONU B2000', category: 'ONU', serialFieldType: 'SN' },
  { name: 'ONT Huawei OptiXstar', category: 'ONT', serialFieldType: 'SN', brand: 'Huawei' },
  { name: 'ONT ZTE (todas)', category: 'ONT', serialFieldType: 'GPON_SN', brand: 'ZTE' },
  { name: 'Router Huawei', category: 'ROUTER', serialFieldType: 'SN', brand: 'Huawei' },
  { name: 'Router ZTE', category: 'ROUTER', serialFieldType: 'D_SN', brand: 'ZTE' },
];

interface RemovalReasonSeed {
  code: RemovalReasonCode;
  label: string;
  sortOrder: number;
}

const removalReasons: RemovalReasonSeed[] = [
  { code: 'DANO_FISICO', label: 'Daño físico', sortOrder: 1 },
  { code: 'NO_ENCIENDE', label: 'No enciende', sortOrder: 2 },
  { code: 'PUERTO_DANADO', label: 'Puerto LAN o RF dañado (no da conectividad)', sortOrder: 3 },
  { code: 'EQUIPO_INHIBIDO', label: 'Equipo inhibido', sortOrder: 4 },
  { code: 'NO_DA_SERVICIO', label: 'No da servicio (navegación, WiFi)', sortOrder: 5 },
  { code: 'NO_SE_APROVISIONA', label: 'No se aprovisiona', sortOrder: 6 },
  { code: 'EQUIPO_OK_CANCELACION', label: 'Equipo OK (cancelación)', sortOrder: 7 },
  { code: 'OTROS', label: 'Otros', sortOrder: 99 },
];

interface SpeedtestServerSeed {
  name: string;
  host: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

const speedtestServers: SpeedtestServerSeed[] = [
  { name: 'Servidor Quito', host: 'quito.speedtest.example.com', city: 'Quito', latitude: -0.180653, longitude: -78.467834 },
  { name: 'Servidor Guayaquil', host: 'guayaquil.speedtest.example.com', city: 'Guayaquil', latitude: -2.170998, longitude: -79.922359 },
];

interface NetworkServerSeed {
  name: string;
  target: string;
  type: NetworkServerType;
}

const networkServers: NetworkServerSeed[] = [
  { name: 'Google DNS', target: '8.8.8.8', type: 'DNS' },
  { name: 'Google DNS Secundario', target: '8.8.4.4', type: 'DNS' },
  { name: 'Cloudflare DNS', target: '1.1.1.1', type: 'DNS' },
  { name: 'Cloudflare CDN', target: 'www.cloudflare.com', type: 'CDN' },
  { name: 'Gateway local', target: '192.168.1.1', type: 'GATEWAY' },
];

async function main(): Promise<void> {
  console.log('Sembrando catálogo de equipos...');
  for (const m of equipmentModels) {
    const existing = await prisma.equipmentModel.findFirst({ where: { name: m.name } });
    if (existing) {
      await prisma.equipmentModel.update({
        where: { id: existing.id },
        data: {
          category: m.category,
          serialFieldType: m.serialFieldType,
          brand: m.brand ?? null,
          active: true,
        },
      });
    } else {
      await prisma.equipmentModel.create({
        data: {
          name: m.name,
          category: m.category,
          serialFieldType: m.serialFieldType,
          brand: m.brand ?? null,
        },
      });
    }
  }

  console.log('Sembrando motivos de retiro...');
  for (const r of removalReasons) {
    await prisma.removalReason.upsert({
      where: { code: r.code },
      update: { label: r.label, sortOrder: r.sortOrder, active: true },
      create: { code: r.code, label: r.label, sortOrder: r.sortOrder },
    });
  }

  console.log('Sembrando servidores de speedtest...');
  for (const s of speedtestServers) {
    const existing = await prisma.speedtestServer.findFirst({ where: { host: s.host } });
    if (existing) {
      await prisma.speedtestServer.update({
        where: { id: existing.id },
        data: {
          name: s.name,
          city: s.city ?? null,
          latitude: s.latitude ?? null,
          longitude: s.longitude ?? null,
          active: true,
        },
      });
    } else {
      await prisma.speedtestServer.create({
        data: {
          name: s.name,
          host: s.host,
          city: s.city ?? null,
          latitude: s.latitude ?? null,
          longitude: s.longitude ?? null,
        },
      });
    }
  }

  console.log('Sembrando servidores de red...');
  for (const n of networkServers) {
    const existing = await prisma.networkServer.findFirst({ where: { target: n.target } });
    if (existing) {
      await prisma.networkServer.update({
        where: { id: existing.id },
        data: { name: n.name, type: n.type, active: true },
      });
    } else {
      await prisma.networkServer.create({
        data: { name: n.name, target: n.target, type: n.type },
      });
    }
  }

  const counts = {
    equipmentModels: await prisma.equipmentModel.count(),
    removalReasons: await prisma.removalReason.count(),
    speedtestServers: await prisma.speedtestServer.count(),
    networkServers: await prisma.networkServer.count(),
  };
  console.log('Catálogos poblados:', counts);
}

main()
  .catch((err) => {
    console.error('Seed falló:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
