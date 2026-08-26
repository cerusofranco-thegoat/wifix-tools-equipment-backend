/**
 * Sonda de la API de operadora (TEC / ISP Monitor).
 *
 * Uso:
 *   npx tsx scripts/probe-tec-api.ts naps -2.1685829163 -79.9189910889
 *   npx tsx scripts/probe-tec-api.ts terminal <SERIAL_GPON_o_MAC_HFC>
 *   npx tsx scripts/probe-tec-api.ts all      <SERIAL_GPON_o_MAC_HFC>
 *
 * Imprime el JSON crudo de cada endpoint para poder calibrar los parsers.
 * Requiere TEC_API_USERNAME / TEC_API_PASSWORD en el .env del backend.
 */
import {
  fetchNearbyNaps,
  fetchTerminal,
  fetchTerminalStatus24h,
  fetchNetworkStatus24h,
  fetchTerminalSnr24h,
  fetchNetworkSnr24h,
  fetchTerminalCodewords24h,
  fetchNetworkCodewords24h,
  normalizeTerminalId,
} from '../src/connectors/http/tec-api.js';

function show(label: string, data: unknown): void {
  console.log(`\n===== ${label} =====`);
  if (data === null) {
    console.log('(204 / sin datos)');
    return;
  }
  const json = JSON.stringify(data, null, 2);
  console.log(json.length > 4000 ? `${json.slice(0, 4000)}\n… (truncado, ${json.length} chars)` : json);
  if (Array.isArray(data)) {
    console.log(`-- array de ${data.length} elementos; claves del primero:`,
      data.length > 0 && typeof data[0] === 'object' && data[0] !== null
        ? Object.keys(data[0] as object)
        : '(escalares)');
  } else if (typeof data === 'object') {
    console.log('-- claves:', Object.keys(data as object));
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'naps') {
    const lat = Number(rest[0]);
    const lng = Number(rest[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('Uso: probe-tec-api.ts naps <lat> <lng>');
    }
    show(`naps ${lat},${lng}`, await fetchNearbyNaps(lat, lng));
    return;
  }

  if (command === 'terminal' || command === 'all') {
    const id = normalizeTerminalId(rest[0] ?? '');
    show(`terminals/${id}`, await fetchTerminal(id));
    if (command === 'all') {
      const probes: Array<[string, Promise<unknown>]> = [
        [`status/${id} (terminal 24h)`, fetchTerminalStatus24h(id)],
        [`network/online/${id} (red 24h)`, fetchNetworkStatus24h(id)],
        [`cablemodem/snr/${id} (SNR terminal 24h)`, fetchTerminalSnr24h(id)],
        [`network/snr/${id} (SNR red 24h)`, fetchNetworkSnr24h(id)],
        [`cablemodem/codewords/${id} (FEC terminal 24h)`, fetchTerminalCodewords24h(id)],
        [`network/codewords/${id} (FEC red 24h)`, fetchNetworkCodewords24h(id)],
      ];
      for (const [label, promise] of probes) {
        try {
          show(label, await promise);
        } catch (err) {
          console.log(`\n===== ${label} =====\nERROR: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return;
  }

  console.log(
    'Uso:\n' +
      '  npx tsx scripts/probe-tec-api.ts naps <lat> <lng>\n' +
      '  npx tsx scripts/probe-tec-api.ts terminal <id>\n' +
      '  npx tsx scripts/probe-tec-api.ts all <id>',
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
