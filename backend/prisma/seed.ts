// Seed de catálogos + usuario inicial — Fase A1 / A1δ (autenticación).
// Idempotente: usa upsert para que correrlo varias veces no rompa.
import type {
  EquipmentCategory,
  EquipmentSerialFieldType,
  RemovalReasonCode,
  NetworkServerType} from '@prisma/client';
import {
  PrismaClient,
  UserRole,
} from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const SEED_USER_EMAIL = process.env.SEED_USER_EMAIL ?? 'franco@tulpasolutions.com';
const SEED_USER_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'wifix-dev-2026';
const SEED_USER_NAME = process.env.SEED_USER_NAME ?? 'Franco Ceruso';
const SEED_USER_ROLE: UserRole =
  (process.env.SEED_USER_ROLE as UserRole | undefined) ?? UserRole.SUPERVISOR;

// Usuarios de prueba de desarrollo (solo en NODE_ENV=development)
const DEV_TECHNICIAN_EMAIL = 'tecnico@wifix.test';
const DEV_TECHNICIAN_NAME = 'Técnico Demo';
const DEV_TECHNICIAN_PASSWORD = 'wifix-tech-2026';

const DEV_AGENT_EMAIL = 'agente@wifix.test';
const DEV_AGENT_NAME = 'Agente Demo';
const DEV_AGENT_PASSWORD = 'wifix-agent-2026';

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
  console.log('Sembrando usuario inicial...');
  const passwordHash = await bcrypt.hash(SEED_USER_PASSWORD, 10);
  await prisma.user.upsert({
    where: { email: SEED_USER_EMAIL },
    update: { name: SEED_USER_NAME, passwordHash, role: SEED_USER_ROLE, active: true },
    create: {
      email: SEED_USER_EMAIL,
      name: SEED_USER_NAME,
      passwordHash,
      role: SEED_USER_ROLE,
      active: true,
    },
  });

  // Usuarios de prueba solo en entorno de desarrollo
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'development') {
    console.log('Sembrando usuarios de prueba de desarrollo...');

    const techHash = await bcrypt.hash(DEV_TECHNICIAN_PASSWORD, 10);
    await prisma.user.upsert({
      where: { email: DEV_TECHNICIAN_EMAIL },
      update: { name: DEV_TECHNICIAN_NAME, passwordHash: techHash, role: 'TECHNICIAN', active: true },
      create: {
        email: DEV_TECHNICIAN_EMAIL,
        name: DEV_TECHNICIAN_NAME,
        passwordHash: techHash,
        role: 'TECHNICIAN',
        active: true,
      },
    });

    const agentHash = await bcrypt.hash(DEV_AGENT_PASSWORD, 10);
    await prisma.user.upsert({
      where: { email: DEV_AGENT_EMAIL },
      update: { name: DEV_AGENT_NAME, passwordHash: agentHash, role: 'AGENT', active: true },
      create: {
        email: DEV_AGENT_EMAIL,
        name: DEV_AGENT_NAME,
        passwordHash: agentHash,
        role: 'AGENT',
        active: true,
      },
    });
  }

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
    users: await prisma.user.count(),
    equipmentModels: await prisma.equipmentModel.count(),
    removalReasons: await prisma.removalReason.count(),
    speedtestServers: await prisma.speedtestServer.count(),
    networkServers: await prisma.networkServer.count(),
  };
  console.log('Datos poblados:', counts);
  console.log('Usuarios por rol:', await prisma.user.groupBy({ by: ['role'], _count: { id: true } }));
}

main()
  .catch((err) => {
    console.error('Seed falló:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
