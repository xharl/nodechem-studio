/**
 * Run-console action for the interchange converters.
 *
 * Renderer-only: no Node APIs, no filesystem. The main process reads the run's
 * saved output, converts it and asks for a destination; this module only sends
 * the run id and the chosen format, and reports the outcome the same way the
 * run-bundle action does.
 */

const FORMAT_LABELS = Object.freeze({
  extxyz: 'extxyz', xyz: 'xyz', sdf: 'sdf', jcamp: 'JCAMP-DX',
});

export function parseExportChoice(value) {
  const [format = '', spectrum = ''] = String(value || '').split(':');
  return { format: format.trim(), spectrum: spectrum.trim() || null };
}

export async function exportRunFormatAction({ desktop, runId, choice, notify } = {}) {
  const say = typeof notify === 'function' ? notify : () => {};
  const { format, spectrum } = parseExportChoice(choice);

  if (!desktop?.exportRunFormat) {
    say('Open the desktop app to export a converted run.');
    return { canceled: true };
  }
  if (!runId) {
    say('Run a calculation before exporting its results.');
    return { error: 'no-run' };
  }
  if (!FORMAT_LABELS[format]) {
    say(`Unknown export format "${format}".`);
    return { error: 'unknown-format' };
  }

  try {
    const result = await desktop.exportRunFormat(runId, format, spectrum);
    if (result?.canceled) return result;
    if (result?.error) {
      say(`Could not export: ${result.error.message}`);
      return result;
    }
    say(`Exported ${result.format} to ${result.path}`);
    return result;
  } catch (error) {
    say(`Could not export: ${error.message}`);
    return { error: error.message };
  }
}
