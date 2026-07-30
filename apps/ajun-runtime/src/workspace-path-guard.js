import fs from 'node:fs/promises';
import path from 'node:path';

export async function prepareWorkspaceFile(workspaceRoot, relativePath) {
  const root = await fs.realpath(String(workspaceRoot || ''));
  const relative = String(relativePath || '').trim().replaceAll('\\', '/');
  if (
    !relative
    || relative.startsWith('/')
    || /^[a-z]:\//i.test(relative)
    || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw guardError('工作区文件必须使用安全相对路径。', 'workspace_path_denied');
  }
  const segments = relative.split('/');
  const fileName = segments.pop();
  let current = root;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await assertDirectoryStillInside(root, current);
      try {
        await fs.mkdir(candidate, { mode:0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      stat = await fs.lstat(candidate);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw guardError('工作区父路径不能包含符号链接或普通文件。', 'workspace_path_denied');
    }
    const realCandidate = await fs.realpath(candidate);
    assertInside(root, realCandidate);
    current = realCandidate;
  }
  await assertDirectoryStillInside(root, current);
  const target = path.join(current, fileName);
  assertInside(root, target);
  return Object.freeze({ root, parent:current, target, relativePath:relative });
}

async function assertDirectoryStillInside(root, directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw guardError('工作区父路径在写入前发生变化。', 'workspace_path_denied');
  }
  const realDirectory = await fs.realpath(directory);
  assertInside(root, realDirectory);
}

function assertInside(root, target) {
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw guardError('工作区路径越界。', 'workspace_path_denied');
  }
}

function guardError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
