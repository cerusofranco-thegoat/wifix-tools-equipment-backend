import { z } from 'zod';

export const AP_TYPE_VALUES = ['router', 'extender', 'mesh_node', 'unknown'] as const;
export const WIFI_BAND_VALUES = ['2.4GHz', '5GHz', '6GHz', 'unknown'] as const;

// MAC: 6 grupos hex separados por ":" o "-", o el sentinel "legacy-unknown"
// que usa la migración para rooms del modelo viejo.
export const bssidSchema = z.string().refine(
  (v) => v === 'legacy-unknown' || /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(v),
  { message: 'bssid debe tener formato MAC (xx:xx:xx:xx:xx:xx) o "legacy-unknown".' },
);

export const wifiAccessPointInputSchema = z.object({
  bssid: bssidSchema,
  ssid: z.string().optional(),
  label: z.string().min(1, 'label es obligatorio.'),
  apType: z.enum(AP_TYPE_VALUES).default('unknown'),
  band: z.enum(WIFI_BAND_VALUES).default('unknown'),
  notes: z.string().optional(),
});
export type WifiAccessPointInput = z.infer<typeof wifiAccessPointInputSchema>;

export const wifiAccessPointUpdateSchema = z
  .object({
    label: z.string().min(1).optional(),
    apType: z.enum(AP_TYPE_VALUES).optional(),
    band: z.enum(WIFI_BAND_VALUES).optional(),
    notes: z.string().optional(),
  })
  .refine(
    (v) => v.label !== undefined || v.apType !== undefined || v.band !== undefined || v.notes !== undefined,
    { message: 'Debe enviarse al menos un campo a actualizar.' },
  );
export type WifiAccessPointUpdate = z.infer<typeof wifiAccessPointUpdateSchema>;
