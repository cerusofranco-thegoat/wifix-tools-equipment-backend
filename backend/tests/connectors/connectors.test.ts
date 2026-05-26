// Verificación del determinismo de los conectores mock.
import { describe, it, expect } from 'vitest';
import {
  comarchMock,
} from '../../src/connectors/comarch/index.js';
import { ispMonitorMock } from '../../src/connectors/ispmonitor/index.js';
import { acsMock } from '../../src/connectors/acs/index.js';
import { tecMock } from '../../src/connectors/tec/index.js';
import { fsmMock } from '../../src/connectors/fsm/index.js';
import { rmsMock } from '../../src/connectors/rms/index.js';

describe('Mocks deterministas — misma clave devuelve los mismos datos', () => {
  it('comarch.getClientProfile es determinista por accountNumber', async () => {
    const a = await comarchMock.getClientProfile('WX-DEMO-001');
    const b = await comarchMock.getClientProfile('WX-DEMO-001');
    expect(a).toEqual(b);
    const c = await comarchMock.getClientProfile('WX-DEMO-002');
    expect(c.fullName).not.toBe(a.fullName);
  });

  it('ispmonitor.getNetworkMetrics tiene tecnología estable y misma signalLevels', async () => {
    const a = await ispMonitorMock.getNetworkMetrics('WX-NETM-001');
    const b = await ispMonitorMock.getNetworkMetrics('WX-NETM-001');
    expect(a.technology).toBe(b.technology);
    expect(a.signalLevels).toEqual(b.signalLevels);
  });

  it('acs devuelve la misma lista de equipos para una misma cuenta', async () => {
    const a = await acsMock.getLanDevices('WX-LAN-001');
    const b = await acsMock.getLanDevices('WX-LAN-001');
    expect(a).toEqual(b);
  });

  it('tec.getNapPorts es determinista por napCode', async () => {
    const a = await tecMock.getNapPorts('NAP-01-02-3');
    const b = await tecMock.getNapPorts('NAP-01-02-3');
    expect(a).toEqual(b);
  });

  it('fsm.getPreviousVisits siempre devuelve al menos 1 visita ordenada por fecha', async () => {
    const visits = await fsmMock.getPreviousVisits('WX-FSM-001');
    expect(visits.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < visits.length - 1; i++) {
      expect(
        visits[i]!.occurredAt.localeCompare(visits[i + 1]!.occurredAt),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('rms.getNodeEvents puede devolver 0 eventos pero es estable', async () => {
    const a = await rmsMock.getNodeEvents('WX-RMS-EMPTY');
    const b = await rmsMock.getNodeEvents('WX-RMS-EMPTY');
    expect(a).toEqual(b);
  });
});

describe('PUT en modo mock refleja el cambio en el siguiente GET', () => {
  it('comarch.updateClientProfile cambia los datos devueltos por getClientProfile', async () => {
    const account = `WX-UPDATE-${Date.now()}`;
    const before = await comarchMock.getClientProfile(account);
    const updated = await comarchMock.updateClientProfile(account, {
      fullName: 'Nombre Editado',
      phones: ['0999999999'],
    });
    expect(updated.fullName).toBe('Nombre Editado');
    expect(updated.phones).toEqual(['0999999999']);
    expect(updated.address).toBe(before.address); // no se editó
    const after = await comarchMock.getClientProfile(account);
    expect(after).toEqual(updated);
  });

  it('acs.updateWifiConfig conserva los SSID editados', async () => {
    const account = `WX-WIFI-${Date.now()}`;
    const before = await acsMock.getWifiConfig(account);
    expect(before.bands.find((b) => b.band === '2.4GHz')?.ssid).toMatch(/WIFIX_/);

    const updated = await acsMock.updateWifiConfig(account, {
      bands: [
        { band: '2.4GHz', ssid: 'CasaNueva', password: 'secreto123' },
        { band: '5GHz', ssid: 'CasaNueva-5G' },
      ],
    });
    expect(updated.bands.find((b) => b.band === '2.4GHz')?.ssid).toBe('CasaNueva');
    expect(updated.bands.find((b) => b.band === '5GHz')?.ssid).toBe('CasaNueva-5G');

    const after = await acsMock.getWifiConfig(account);
    expect(after.bands).toEqual(updated.bands);
  });
});
