import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  const canonical = canonicalize({
    sourceTaskId:String(sourceTaskId || '').trim(),
    sourceArtifactId:String(sourceArtifactId || '').trim(),
    sourceIssueId:String(sourceIssueId || '').trim(),
    pipelineCaseId:String(pipelineCaseId || '').trim(),
    projectId:String(projectId || '').trim(),
    sourceRunId:String(sourceRunId || '').trim(),
    artifactKind:String(artifactKind || '').trim(),
    artifact:artifact ?? null,
  });
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

export function validM5WorkProductArtifactHash(metadata) {
  const expected = String(metadata?.artifactHash || '').trim().toLowerCase();
  return /^sha256:[0-9a-f]{64}$/.test(expected)
    && expected === m5WorkProductArtifactHash(metadata);
}

export async function assertM5WorkspaceArtifact({
  workspaceRoot,
  relativePath,
  checksum,
  declaredBytes = null,
} = {}) {
  const rootInput = String(workspaceRoot || '').trim();
  const relative = safeWorkspaceRelativePath(relativePath);
  const expected = String(checksum || '').trim().toLowerCase();
  if (!rootInput || !relative || !/^sha256:[0-9a-f]{64}$/.test(expected)) {
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
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
