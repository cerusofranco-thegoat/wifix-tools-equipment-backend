// Planes simulados SIMÉTRICOS (ronda 2026-10-06): subida === bajada siempre.
import { describe, it, expect } from 'vitest';
import { comarchMock, MOCK_PLANS } from '../../src/connectors/comarch/index.js';

describe('planes del mock de Comarch', () => {
  it('todos los planes son simétricos', () => {
    expect(MOCK_PLANS.length).toBeGreaterThan(0);
    for (const plan of MOCK_PLANS) expect(plan.up).toBe(plan.down);
    expect(MOCK_PLANS.find((p) => p.down === 1000)?.up).toBe(1000);
  });

  it('el perfil de cualquier cuenta trae subida === bajada', async () => {
    for (let i = 0; i < 60; i++) {
      const profile = await comarchMock.getClientProfile(String(35000000 + i * 7919));
      expect(profile.contractedUploadMbps).toBe(profile.contractedDownloadMbps);
    }
  });
});
