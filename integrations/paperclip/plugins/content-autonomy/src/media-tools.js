import { mediaArtifactPackage } from './media-artifact-package.js';
import { mediaProviderLineage } from './media-provider-lineage.js';
import { mediaRuntime } from './media-runtime.js';

const {
  probe:mediaProbe,
  validate:mediaValidate,
  finalize:mediaFinalize,
  encodeArgs:buildFinalEncodeArgs,
  parseBlack:parseBlackDetect,
  parseLoudness:parseEbur128,
} = mediaRuntime.ffmpeg;
const {
  verifyAction:verifyProviderAction,
  fromConfirmedActions:buildStepFunArtifactLineageFromConfirmedActions,
  fromLedger:buildStepFunArtifactLineage,
} = mediaProviderLineage;
const {
  write:writeM5ArtifactPackage,
  validate:validateArtifactLineage,
} = mediaArtifactPackage;

export {
  buildFinalEncodeArgs,
  buildStepFunArtifactLineage,
  buildStepFunArtifactLineageFromConfirmedActions,
  mediaFinalize,
  mediaProbe,
  mediaValidate,
  parseBlackDetect,
  parseEbur128,
  validateArtifactLineage,
  verifyProviderAction,
  writeM5ArtifactPackage,
};
