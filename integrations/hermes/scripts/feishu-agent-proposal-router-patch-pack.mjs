import { installFeishuExperiencePatches } from './feishu-experience-patches.mjs';
import { migrateFeishuCommanderRouter } from './feishu-commander-router-patches.mjs';

export {
  upgradeFeishuReactionReliabilityPatch,
  upgradeFeishuSenderIdentityPatch,
} from './feishu-experience-patches.mjs';

export function applyPatch(source) {
  const migration = migrateFeishuCommanderRouter(source);
  return migration.terminal ? migration.source : installFeishuExperiencePatches(migration.source);
}
