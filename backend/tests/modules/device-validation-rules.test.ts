// Regla pura de validación de equipo vs plan + parseo de la planilla del
// catálogo. Sin base de datos.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  evaluateDeviceValidation,
  findCatalogItem,
  type DeviceCatalogItem,
} from '../../src/modules/device-validation/device-validation.rules.js';
import {
  parseDeviceCatalogRows,
  parseWifiCell,
  serialPrefixesFor,
} from '../../src/modules/device-validation/device-catalog.import.js';

const CATALOG = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../prisma/catalogs/device-catalog.json', import.meta.url)),
      'utf8',
    ),
  ) as { items: DeviceCatalogItem[] }
).items;

function device(model: string): DeviceCatalogItem {
  const d = findCatalogItem(CATALOG, model);
  if (!d) throw new Error(`modelo ${model} no está en el seed`);
  return d;
}

describe('evaluateDeviceValidation', () => {
  it('plan 1000 con ZXHN F670L → blocked por WiFi (500)', () => {
    const v = evaluateDeviceValidation(device('ZXHN F670L'), 1000);
    expect(v.result).toBe('blocked');
    expect(v.reasons).toEqual([{ kind: 'wifi', deviceMbps: 500, planMbps: 1000 }]);
    expect(v.message).toContain('Advertencia: el dispositivo que usted está instalando no es el correcto');
    expect(v.message).toContain('plan contratado (1000 Mbps)');
    expect(v.message).toContain('WiFi: 500 Mbps');
  });

  it('plan 1000 con F6600 → ok (iguala, no supera)', () => {
    const v = evaluateDeviceValidation(device('ONT ZTE ZXHN F6600 WIFI 6'), 1000);
    expect(v).toMatchObject({ result: 'ok', reasons: [] });
    expect(v.message).toContain('1000 Mbps');
  });

  it('plan 500 con F660 → ok: WiFi desactivado, solo cuenta Ethernet', () => {
    const f660 = device('ZXHN F660');
    expect(f660.wifiStatus).toBe('disabled');
    expect(evaluateDeviceValidation(f660, 500)).toMatchObject({ result: 'ok', reasons: [] });
    // Aunque el plan supere sus 300 Mbps de WiFi (informativo).
    expect(evaluateDeviceValidation(f660, 1000).result).toBe('ok');
  });

  it('plan 1000 con powerline → blocked por Ethernet (100) y WiFi (300)', () => {
    const v = evaluateDeviceValidation(device('POWER LINE TP-LINK TLWPA4220 STARTER KIT'), 1000);
    expect(v.result).toBe('blocked');
    expect(v.reasons).toEqual([
      { kind: 'ethernet', deviceMbps: 100, planMbps: 1000 },
      { kind: 'wifi', deviceMbps: 300, planMbps: 1000 },
    ]);
    expect(v.message).toContain('Ethernet 100 Mbps y WiFi 300 Mbps');
  });

  it('plan 2000 con F8605P → blocked solo por WiFi (1800); Ethernet 2500 alcanza', () => {
    const v = evaluateDeviceValidation(device('ONT ZTE XGS-PON ZXHN F8605P'), 2000);
    expect(v.result).toBe('blocked');
    expect(v.reasons).toEqual([{ kind: 'wifi', deviceMbps: 1800, planMbps: 2000 }]);
  });

  it('modelo inexistente u obsoleto → blocked not_in_catalog', () => {
    expect(findCatalogItem(CATALOG, 'ROUTER LINKSYS E2500 WIFI 300 MBPS')).toBeNull();
    const v = evaluateDeviceValidation(null, 1000, 'ROUTER LINKSYS E2500 WIFI 300 MBPS');
    expect(v.result).toBe('blocked');
    expect(v.reasons).toEqual([{ kind: 'not_in_catalog', planMbps: 1000 }]);
    expect(v.message).toContain('«ROUTER LINKSYS E2500 WIFI 300 MBPS»');
    expect(v.message).toContain('homologados');
  });

  it('no homologado gana aunque no haya plan', () => {
    const v = evaluateDeviceValidation(null, null, 'XYZ');
    expect(v.result).toBe('blocked');
    expect(v.reasons).toEqual([{ kind: 'not_in_catalog' }]);
  });

  it('sin plan → unknown_plan (no bloquea)', () => {
    for (const plan of [null, 0, -5, Number.NaN]) {
      const v = evaluateDeviceValidation(device('ZXHN F670L'), plan);
      expect(v).toMatchObject({ result: 'unknown_plan', reasons: [] });
    }
  });

  it('ONT sin WiFi: solo Ethernet', () => {
    expect(evaluateDeviceValidation(device('ZXHN F601'), 1000).result).toBe('ok');
    expect(evaluateDeviceValidation(device('ZXHN F601'), 2000).reasons).toEqual([
      { kind: 'ethernet', deviceMbps: 1000, planMbps: 2000 },
    ]);
  });
});

describe('findCatalogItem', () => {
  it('sin distinguir mayúsculas ni espacios, y también por displayName', () => {
    expect(findCatalogItem(CATALOG, '  zxhn   f670l ')?.model).toBe('ZXHN F670L');
    expect(findCatalogItem(CATALOG, 'ONT XGS-PON ZXHN F8605P')?.model).toBe('ONT ZTE XGS-PON ZXHN F8605P');
    expect(findCatalogItem(CATALOG, '')).toBeNull();
  });
});

describe('catálogo: parseo de la planilla', () => {
  const header = [
    'MODELO',
    'MODELO_DISPLAY',
    'MARCA',
    'TIPO_EQUIPO',
    'CATEGORIA',
    'TECNOLOGÍA WIFI',
    'ESTADO_EQUIPO',
    'VELOCIDAD MAXIMA DE ENLACE ETHERNET Mbps',
    'VELOCIDAD MAXIMA DE ENLACE WIFI Mbps',
  ];

  it('solo Moderno; mapea N/A, DESACTIVADO y numérico; obsoletos aparte', () => {
    const parsed = parseDeviceCatalogRows([
      header,
      ['ROUTER NETGEAR 150 MBPS', 'ROUTER NETGEAR 150 MBPS', 'NETGEAR', 'ROUTER', 'Router WiFi', 'WIFI 4', 'Obsoleto', 'Obsoleto', 'Obsoleto'],
      ['ZXHN F660', 'ZXHN F660', 'ZTE', 'ONT', 'ONT / ONU (GPON)', 'WIFI 4', 'Moderno', 1000, '300 DESACTIVADO'],
      ['ONU300G-1G', 'ONU300G-1G', 'Blik Telecom', 'ONT', 'ONT / ONU (GPON)', 'SIN WIFI', 'Moderno', 1000, 'N/A'],
      ['AX3 DUAL CORE WIFI 6', 'AX3 DUAL CORE WIFI 6', 'HUAWEI', 'ROUTER', 'Router WiFi', 'WIFI 6', 'Moderno', 1000, 1000],
      [],
    ]);
    expect(parsed.obsoleteModels).toEqual(['ROUTER NETGEAR 150 MBPS']);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.items.map((i) => [i.model, i.wifiStatus, i.wifiMaxMbps, i.serialPrefixes])).toEqual([
      ['ZXHN F660', 'disabled', 300, ['ZTEG']],
      ['ONU300G-1G', 'none', null, ['STGU']],
      ['AX3 DUAL CORE WIFI 6', 'enabled', 1000, ['BWH']],
    ]);
  });

  it('falta una columna obligatoria → error', () => {
    expect(() => parseDeviceCatalogRows([['MODELO', 'MARCA']])).toThrow(/Falta la columna/);
  });

  it('parseWifiCell', () => {
    expect(parseWifiCell('N/A')).toEqual({ wifiStatus: 'none', wifiMaxMbps: null });
    expect(parseWifiCell('300 DESACTIVADO')).toEqual({ wifiStatus: 'disabled', wifiMaxMbps: 300 });
    expect(parseWifiCell(1800)).toEqual({ wifiStatus: 'enabled', wifiMaxMbps: 1800 });
    expect(parseWifiCell('abc')).toBeNull();
  });

  it('serialPrefixesFor: pistas de marca de Equipos Retirados', () => {
    const p = (model: string, brand: string, deviceType: string): string[] =>
      serialPrefixesFor({ model, brand, deviceType });
    expect(p('ROUTER ZXHN H3601P V9 WIFI 6', 'ZTE', 'ROUTER')).toEqual(['ZTEL']);
    expect(p('ZXHN F670L', 'ZTE', 'ONT')).toEqual(['ZTEG']);
    expect(p('ONT OptiXstar HG8145X6', 'HUAWEI', 'ONT')).toEqual(['HWTC']);
    expect(p('AX3 QUAD CORE WIFI 6', 'HUAWEI', 'ROUTER')).toEqual(['BWH']);
    expect(p('ONT HUR 2001', 'INTELLEGO', 'ONT')).toEqual(['STGU']);
    expect(p('ONU HUR4101XR', 'INTELLEGO', 'ONT')).toEqual(['STGU']);
    expect(p('ONU Bridge TXG-B2000', 'ONU', 'ONT')).toEqual(['XPON']);
    expect(p('POWER LINE TP-LINK TLWPA4220 STARTER KIT', 'TP-LINK', 'REPETIDOR POWERLINE')).toEqual([]);
  });

  it('el seed del repo tiene los 19 modelos Moderno', () => {
    expect(CATALOG).toHaveLength(19);
    expect(new Set(CATALOG.map((d) => d.model)).size).toBe(19);
  });
});
