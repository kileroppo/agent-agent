import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  deriveM5WorkProductArtifactHash,
  normalizeM5Sha256,
  validM5WorkProductArtifactHash as validSharedM5WorkProductArtifactHash,
} from '@agent-army/m5-contracts';

export class M5WorkspaceArtifactError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'M5WorkspaceArtifactError';
    this.code = code;
  }
}

export function m5WorkProductArtifactHash({
  sourceTaskId,
  sourceArtifactId,
  sourceIssueId,
  pipelineCaseId,
  projectId,
  sourceRunId,
  artifactKind,
  artifact,
} = {}) {
  return deriveM5WorkProductArtifactHash({
    sourceTaskId,
    sourceArtifactId,
    sourceIssueId,
    pipelineCaseId,
    projectId,
    sourceRunId,
    artifactKind,
    artifact,
  });
}

export function validM5WorkProductArtifactHash(metadata) {
  return validSharedM5WorkProductArtifactHash(metadata);
}

export async function assertM5WorkspaceArtifact({
  workspaceRoot,
  relativePath,
  checksum,
  declaredBytes = null,
} = {}) {
  const rootInput = String(workspaceRoot || '').trim();
  const relative = safeWorkspaceRelativePath(relativePath);
  const expected = normalizeM5Sha256(checksum);
  if (!rootInput || !relative || !expected) {
    throw new M5WorkspaceArtifactError(
      '受控工作区路径或 sha256 缺失',
      'workspace_artifact_reference_invalid',
    );
  }
  let realRoot;
  let realFile;
  let bytes;
  try {
    realRoot = await fs.realpath(path.resolve(rootInput));
    const candidate = path.resolve(realRoot, relative);
    if (!candidate.startsWith(`${realRoot}${path.sep}`)) throw new Error('workspace escape');
    const stat = await fs.lstat(candidate);
    realFile = await fs.realpath(candidate);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || !realFile.startsWith(`${realRoot}${path.sep}`)
    ) {
      throw new Error('unsafe file');
    }
    bytes = await fs.readFile(realFile);
  } catch {
    throw new M5WorkspaceArtifactError(
      '受控工作区文件不存在或路径漂移',
      'workspace_artifact_path_drift',
    );
  }
  const actualChecksum = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (
    actualChecksum !== expected
    || (
      declaredBytes != null
      && (!Number.isInteger(Number(declaredBytes)) || Number(declaredBytes) !== bytes.length)
    )
  ) {
    throw new M5WorkspaceArtifactError(
      '工作区文件 bytes 或 sha256 已漂移',
      'workspace_artifact_content_drift',
    );
  }
  return Object.freeze({
    relativePath:relative,
    realPath:realFile,
    checksum:actualChecksum,
    bytes:bytes.length,
  });
}

function safeWorkspaceRelativePath(value) {
  const relative = String(value || '').trim().replaceAll('\\', '/');
  if (
    !relative
    || relative.startsWith('/')
    || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) return null;
  return relative;
}
