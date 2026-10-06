// Tecnología, equipo y red de acceso SIMULADOS por cuenta (fuente única de
// ISP Monitor por cuenta, network-metrics y la orden simulada).
import { describe, it, expect } from 'vitest';
import {
  canonicalAccount,
  resolveAccountTechnology,
  simulatedAccessLayout,
  simulatedClientDevice,
} from '../../src/connectors/ispmonitor/account-simulation.js';
import { technologyFromIdFormat } from '../../src/connectors/ispmonitor/access-metrics.js';
import { ispMonitorMock } from '../../src/connectors/ispmonitor/index.js';

const ACCOUNTS = Array.from({ length: 2000 }, (_, i) => String(100_000_000 + i * 7919));

describe('resolveAccountTechnology', () => {
  it('es determinística y no depende de ceros a la izquierda ni espacios', () => {
    for (const account of ACCOUNTS.slice(0, 50)) {
      const t = resolveAccountTechnology(account);
      expect(resolveAccountTechnology(account)).toBe(t);
      expect(resolveAccountTechnology(`00${account}`)).toBe(t);
      expect(resolveAccountTechnology(` ${account} `)).toBe(t);
    }
    expect(canonicalAccount(' 000123456 ')).toBe('123456');
  });

  it('reparte ≈70 % GPON / 30 % HFC', () => {
    const gpon = ACCOUNTS.filter((a) => resolveAccountTechnology(a) === 'GPON').length;
    const ratio = gpon / ACCOUNTS.length;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(0.75);
  });
});

describe('simulatedClientDevice / simulatedAccessLayout', () => {
  it('GPON → ONT ZTE (ZTEG + 8 hex); HFC → cablemódem identificado por MAC de 12 hex', () => {
    for (const account of ACCOUNTS.slice(0, 300)) {
      const device = simulatedClientDevice(account);
      expect(device).toEqual(simulatedClientDevice(account));
      expect(device.technology).toBe(resolveAccountTechnology(account));
      expect(device.mac).toMatch(/^[0-9A-F]{12}$/);
      // Buscar ese id en /terminals/:id da la misma tecnología.
      expect(technologyFromIdFormat(device.ispId)).toBe(device.technology);
      if (device.technology === 'GPON') {
        expect(device.ispId).toMatch(/^ZTEG[0-9A-F]{8}$/);
        expect(device.serial).toBe(device.ispId);
        expect(device.orderModel).toBe('ONT ZTE ZXHN F6600 WIFI 6');
      } else {
        expect(device.ispId).toBe(device.mac);
        expect(device.serial).toMatch(/^HTRN\d{9}$/);
        expect(device.orderModel).toBe('CABLEMODEM HITRON CODA-4582U');
      }
    }
  });

  it('red de acceso y NAP/tap con el formato de la operadora', () => {
    for (const account of ACCOUNTS.slice(0, 300)) {
      const layout = simulatedAccessLayout(account);
      expect(layout.accessNetwork).toMatch(/^[A-Z]{2}\d[A-Z]{2}$/);
      expect(layout.clientNap).toMatch(/^[A-Z]{2}\d[NT][A-F]\d$/);
      expect(layout.clientNap.slice(0, 3)).toBe(layout.accessNetwork.slice(0, 3));
      expect(layout.clientNap[3]).toBe(layout.technology === 'GPON' ? 'N' : 'T');
    }
  });
});

describe('network-metrics (mock) — DOCSIS solo en HFC, óptica solo en GPON', () => {
  it('usa la tecnología de la cuenta y separa los bloques', async () => {
    const seen = new Set<string>();
    for (const account of ACCOUNTS.slice(0, 200)) {
      const m = await ispMonitorMock.getNetworkMetrics(account);
      expect(m.technology).toBe(resolveAccountTechnology(account));
      seen.add(m.technology);
      if (m.technology === 'GPON') {
        expect(typeof m.signalLevels?.rxDbm).toBe('number');
        expect(typeof m.signalLevels?.txDbm).toBe('number');
        expect(m).not.toHaveProperty('signalToNoiseDb');
        expect(m).not.toHaveProperty('fecCorrectedPercent');
        expect(m).not.toHaveProperty('fecUncorrectedPercent');
      } else {
        expect(m.signalLevels).toBeNull();
        expect(typeof m.signalToNoiseDb).toBe('number');
        expect(typeof m.fecCorrectedPercent).toBe('number');
        expect(typeof m.fecUncorrectedPercent).toBe('number');
      }
    }
    expect(seen).toEqual(new Set(['GPON', 'HFC']));
  });
});
