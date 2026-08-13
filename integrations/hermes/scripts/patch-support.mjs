import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SUPPORTED_HERMES_VERSION = '0.19.0';
export const SUPPORTED_HERMES_GIT_COMMIT = 'fd39696ccfbb1221ac9fdb6119f629f9821e195d';

export function defaultHermesRoot(environmentKey = 'HERMES_HOME') {
  return process.env[environmentKey]
    || path.join(process.env.HOME || '', '.hermes', 'hermes-agent');
}

export function defaultHermesTarget(relativePath, environmentKey = 'HERMES_HOME') {
  return path.join(defaultHermesRoot(environmentKey), relativePath);
}

export function resolveHermesTarget(input, relativePath) {
  if (!input.endsWith('.py')) {
    return { root: input, filePath: path.join(input, relativePath) };
  }
  const root = path.resolve(
    path.dirname(input),
    ...Array(relativePath.split(path.sep).length - 1).fill('..'),
  );
  return { root, filePath: input };
}

export function replaceRequired(source, anchor, replacement, errorMessage) {
  if (!source.includes(anchor)) throw new Error(errorMessage);
  return source.replace(anchor, replacement);
}

export function replaceExactlyOnce(source, anchor, replacement, errorMessage) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(errorMessage);
  }
  return source.replace(anchor, replacement);
}

export function assertSupportedHermesCompatibility({ version, gitCommit }) {
  if (version !== SUPPORTED_HERMES_VERSION || gitCommit !== SUPPORTED_HERMES_GIT_COMMIT) {
    throw new Error(
      `Hermes 版本未通过锁定校验：需要 ${SUPPORTED_HERMES_VERSION}@${SUPPORTED_HERMES_GIT_COMMIT.slice(0, 12)}，`
      + `实际为 ${version || 'unknown'}@${String(gitCommit || 'unknown').slice(0, 12)}；拒绝猜测补丁。`,
    );
  }
}

export async function verifyHermesTarget(filePath, expectedRelativePath) {
  const { root } = resolveHermesTarget(filePath, expectedRelativePath);
  const actualRelativePath = path.relative(root, path.resolve(filePath));
  if (actualRelativePath !== expectedRelativePath) {
    throw new Error(`Hermes 补丁目标路径不匹配：${actualRelativePath}`);
  }
  const pyproject = await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8');
  const version = pyproject.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1];
  let gitCommit = '';
  try {
    gitCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding:'utf8',
      stdio:['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('Hermes 安装缺少可验证 Git 身份；拒绝修改。');
  }
  assertSupportedHermesCompatibility({ version, gitCommit });
  return { root, version, gitCommit };
}

export async function resolveAndVerifyHermesTarget(input, expectedRelativePath) {
  const { filePath } = resolveHermesTarget(input, expectedRelativePath);
  const compatibility = await verifyHermesTarget(filePath, expectedRelativePath);
  return { ...compatibility, filePath };
}

export async function patchHermesTextFile({ input, relativePath, transform }) {
  const [result] = await patchHermesTextFiles([{ input, relativePath, transform }]);
  return result;
}

export async function patchHermesTextFiles(specifications) {
  const verified = [];
  for (const specification of specifications) {
    const target = await resolveAndVerifyHermesTarget(
      specification.input,
      specification.relativePath,
    );
    verified.push({ ...target, transform: specification.transform });
  }
  return transformAndWriteTextFiles(verified);
}

export async function transformAndWriteTextFiles(targets) {
  const prepared = [];
  for (const target of targets) {
    const original = await fs.readFile(target.filePath, 'utf8');
    const patched = target.transform(original);
    prepared.push({ ...target, patched });
  }
  const results = [];
  for (const target of prepared) {
    const changed = await atomicWriteFile(target.filePath, target.patched);
    const { patched: _patched, transform: _transform, ...result } = target;
    results.push({ ...result, changed });
  }
  return results;
}

export async function atomicWriteFile(filePath, content) {
  const nextContent = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    const currentContent = await fs.readFile(filePath);
    if (currentContent.equals(nextContent)) return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let mode = 0o644;
  try {
    mode = (await fs.stat(filePath)).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.rename(temporary, filePath);
    return true;
  } catch (error) {
    await fs.rm(temporary, { force:true }).catch(() => {});
    throw error;
  }
}
