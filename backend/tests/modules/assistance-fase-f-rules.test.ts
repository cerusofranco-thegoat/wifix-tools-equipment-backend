/**
 * Tests de las reglas puras de auto-asistencia (Fase F).
 * Sin base de datos, sin conectores, funciones puras.
 */
import { describe, it, expect } from 'vitest';
import {
  detectCausesAndProposals,
  THRESHOLDS,
  type AutoAssistMetrics,
} from '../../src/modules/assistance/auto-assist.rules.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metricsBase(): AutoAssistMetrics {
  return {
    plant: null,
    wifiDeviceCount: null,
    wifiChannel24: null,
    wifiChannel5: null,
    avgWifiSignalDbm: null,
  };
}

// ---------------------------------------------------------------------------
// Sin causas
// ---------------------------------------------------------------------------

describe('detectCausesAndProposals — sin causas', () => {
  it('devuelve listas vacías cuando no hay métricas', () => {
    const { causes, proposals } = detectCausesAndProposals(metricsBase());
    expect(causes).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });

  it('devuelve listas vacías cuando todas las métricas están en rango normal', () => {
    const metrics: AutoAssistMetrics = {
      plant: {
        accountNumber: 'WX-OK',
        technology: 'GPON',
        onuRxPower: -15,          // en rango [-8, -27]
        snr: 35,                   // > 28 dB
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
      wifiDeviceCount: 3,          // < 6
      wifiChannel24: 6,
      wifiChannel5: 36,
      avgWifiSignalDbm: -55,       // > -70 dBm
    };
    const result = detectCausesAndProposals(metrics);
    expect(result.causes).toHaveLength(0);
    expect(result.proposals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WIFI_SIGNAL_LOW
// ---------------------------------------------------------------------------

describe('detectCausesAndProposals — WIFI_SIGNAL_LOW', () => {
  it('detecta señal baja cuando avgWifiSignalDbm < THRESHOLD', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      avgWifiSignalDbm: -75, // < -70
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'WIFI_SIGNAL_LOW')).toBe(true);
  });

  it('propone SET_CHANNEL al detectar señal baja', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      avgWifiSignalDbm: -80,
    };
    const { proposals } = detectCausesAndProposals(metrics);
    expect(proposals.some((p) => p.action === 'SET_CHANNEL')).toBe(true);
  });

  it('NO detecta señal baja cuando está en umbral exacto', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      avgWifiSignalDbm: THRESHOLDS.WIFI_SIGNAL_MIN_DBM, // = -70
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'WIFI_SIGNAL_LOW')).toBe(false);
  });

  it('propuesta sugiere canal 2.4GHz diferente al actual', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      avgWifiSignalDbm: -80,
      wifiChannel24: 1, // canal actual
    };
    const { proposals } = detectCausesAndProposals(metrics);
    const setChannel = proposals.find((p) => p.cause === 'WIFI_SIGNAL_LOW' && p.action === 'SET_CHANNEL');
    expect(setChannel).toBeDefined();
    expect((setChannel?.params as { channel: number }).channel).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SNR_DEGRADED
// ---------------------------------------------------------------------------

describe('detectCausesAndProposals — SNR_DEGRADED', () => {
  it('detecta SNR degradado cuando snr < THRESHOLD', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-SNR',
        technology: 'GPON',
        onuRxPower: -15,
        snr: 25,           // < 28 dB
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes, proposals } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'SNR_DEGRADED')).toBe(true);
    expect(proposals.some((p) => p.cause === 'SNR_DEGRADED' && p.action === 'REPROVISION')).toBe(true);
  });

  it('NO detecta SNR degradado cuando está OK', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-OK',
        technology: 'GPON',
        onuRxPower: -15,
        snr: 35,
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'SNR_DEGRADED')).toBe(false);
  });

  it('la remediación SNR_DEGRADED NO es reversible (reprovision)', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-SNR',
        technology: 'GPON',
        onuRxPower: -15,
        snr: 20,
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { proposals } = detectCausesAndProposals(metrics);
    const p = proposals.find((r) => r.cause === 'SNR_DEGRADED');
    expect(p?.reversible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CHANNEL_SATURATED
// ---------------------------------------------------------------------------

describe('detectCausesAndProposals — CHANNEL_SATURATED', () => {
  it('detecta canal saturado cuando wifiDeviceCount >= THRESHOLD', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      wifiDeviceCount: THRESHOLDS.WIFI_CHANNEL_SATURATION_DEVICES, // = 6
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'CHANNEL_SATURATED')).toBe(true);
  });

  it('propone SET_CHANNEL en ambas bandas cuando hay saturación', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      wifiDeviceCount: 10,
    };
    const { proposals } = detectCausesAndProposals(metrics);
    const channelProps = proposals.filter((p) => p.cause === 'CHANNEL_SATURATED' && p.action === 'SET_CHANNEL');
    expect(channelProps.length).toBeGreaterThanOrEqual(2);
    const bands = channelProps.map((p) => (p.params as { band: string }).band);
    expect(bands).toContain('2.4GHz');
    expect(bands).toContain('5GHz');
  });

  it('NO detecta saturación con 5 dispositivos (por debajo del umbral)', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      wifiDeviceCount: 5,
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'CHANNEL_SATURATED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ONU_RX_POWER_OUT_OF_RANGE
// ---------------------------------------------------------------------------

describe('detectCausesAndProposals — ONU_RX_POWER_OUT_OF_RANGE', () => {
  it('detecta ONU RxPower por debajo del mínimo', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-ONU',
        technology: 'GPON',
        onuRxPower: -30,   // < -27 (MIN)
        snr: 35,
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes, proposals } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'ONU_RX_POWER_OUT_OF_RANGE')).toBe(true);
    expect(proposals.some((p) => p.cause === 'ONU_RX_POWER_OUT_OF_RANGE' && p.action === 'REBOOT')).toBe(true);
  });

  it('detecta ONU RxPower por encima del máximo', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-ONU',
        technology: 'GPON',
        onuRxPower: -5,    // > -8 (MAX)
        snr: 35,
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'ONU_RX_POWER_OUT_OF_RANGE')).toBe(true);
  });

  it('NO detecta ONU RxPower fuera de rango cuando está en el límite inferior exacto', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-ONU',
        technology: 'GPON',
        onuRxPower: THRESHOLDS.ONU_RX_POWER_MIN_DBM, // = -27
        snr: 35,
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'ONU_RX_POWER_OUT_OF_RANGE')).toBe(false);
  });

  it('la remediación ONU es reversible (reboot)', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-ONU',
        technology: 'GPON',
        onuRxPower: -30,
        snr: 35,
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { proposals } = detectCausesAndProposals(metrics);
    const p = proposals.find((r) => r.cause === 'ONU_RX_POWER_OUT_OF_RANGE');
    expect(p?.reversible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HFC — CABLEMODEM_DOWNSTREAM_LOW y CABLEMODEM_MER_LOW
// ---------------------------------------------------------------------------

describe('detectCausesAndProposals — HFC causas', () => {
  it('detecta CABLEMODEM_DOWNSTREAM_LOW cuando downstream < THRESHOLD', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-HFC',
        technology: 'HFC',
        onuRxPower: -15,
        snr: 35,
        source: 'ispmonitor',
        cablemodemDownstreamPower: -8,   // < -5 dBmV
        cablemodemUpstreamPower: 45,
        cablemodemMer: 35,
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes, proposals } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'CABLEMODEM_DOWNSTREAM_LOW')).toBe(true);
    expect(proposals.some((p) => p.cause === 'CABLEMODEM_DOWNSTREAM_LOW' && p.action === 'REPROVISION')).toBe(true);
  });

  it('detecta CABLEMODEM_MER_LOW cuando MER < THRESHOLD', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-HFC',
        technology: 'HFC',
        onuRxPower: -15,
        snr: 35,
        source: 'ispmonitor',
        cablemodemDownstreamPower: 5,
        cablemodemUpstreamPower: 45,
        cablemodemMer: 25,              // < 30 dB
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes, proposals } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'CABLEMODEM_MER_LOW')).toBe(true);
    expect(proposals.some((p) => p.cause === 'CABLEMODEM_MER_LOW' && p.action === 'REBOOT')).toBe(true);
  });

  it('NO detecta causas HFC cuando tecnología es GPON', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      plant: {
        accountNumber: 'WX-GPON',
        technology: 'GPON',
        onuRxPower: -15,
        snr: 35,
        source: 'ispmonitor',
        // Los campos cablemodem no están definidos para GPON
        measuredAt: '2026-06-07T00:00:00Z',
      },
    };
    const { causes } = detectCausesAndProposals(metrics);
    expect(causes.some((c) => c.code === 'CABLEMODEM_DOWNSTREAM_LOW')).toBe(false);
    expect(causes.some((c) => c.code === 'CABLEMODEM_MER_LOW')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Múltiples causas simultáneas
// ---------------------------------------------------------------------------

describe('detectCausesAndProposals — causas múltiples', () => {
  it('detecta múltiples causas a la vez', () => {
    const metrics: AutoAssistMetrics = {
      plant: {
        accountNumber: 'WX-MULTI',
        technology: 'GPON',
        onuRxPower: -31,    // ONU out of range
        snr: 22,             // SNR degraded
        source: 'ispmonitor',
        measuredAt: '2026-06-07T00:00:00Z',
      },
      wifiDeviceCount: 8,   // channel saturated
      wifiChannel24: 11,
      wifiChannel5: null,
      avgWifiSignalDbm: -80, // wifi signal low
    };
    const { causes, proposals } = detectCausesAndProposals(metrics);
    expect(causes.length).toBeGreaterThanOrEqual(4);
    expect(proposals.length).toBeGreaterThan(0);

    const codes = causes.map((c) => c.code);
    expect(codes).toContain('WIFI_SIGNAL_LOW');
    expect(codes).toContain('SNR_DEGRADED');
    expect(codes).toContain('CHANNEL_SATURATED');
    expect(codes).toContain('ONU_RX_POWER_OUT_OF_RANGE');
  });
});

// ---------------------------------------------------------------------------
// Gating por consentimiento — verificado en auto-assist.service (con BD)
// Aquí verificamos la lógica pura de propuestas (previousState siempre null)
// ---------------------------------------------------------------------------

describe('propuestas — previousState siempre null', () => {
  it('todas las propuestas tienen previousState: null al crearse', () => {
    const metrics: AutoAssistMetrics = {
      ...metricsBase(),
      avgWifiSignalDbm: -80,
      wifiDeviceCount: 8,
    };
    const { proposals } = detectCausesAndProposals(metrics);
    for (const p of proposals) {
      expect(p.previousState).toBeNull();
    }
  });
});
