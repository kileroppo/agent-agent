import { startRuntime } from './runtime-start.js';

const backgroundServicesEnabled = String(process.env.AJUN_DISABLE_BACKGROUND_SERVICES || '')
  .trim()
  .toLowerCase() !== 'true';

await startRuntime({ startBackgroundServices:backgroundServicesEnabled });
