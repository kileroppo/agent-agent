import { startRuntime } from './runtime-start.ts';

const backgroundServicesEnabled = String(process.env.AJUN_DISABLE_BACKGROUND_SERVICES || '')
  .trim()
  .toLowerCase() !== 'true';

await startRuntime({ startBackgroundServices:backgroundServicesEnabled });
