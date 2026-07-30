import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { coded } from './policy.js';

const LEASE_DIRECTORY = '.publisher-leases';
const COPY_BUFFER_BYTES = 1024 * 1024;

export class WorkspaceArtifactVerifier {
  constructor(rootPath) {
    if (!path.isAbsolute(rootPath)) throw coded('invalid_workspace_root', '发布工作区必须使用绝对路径。');
    this.rootPath = rootPath;
  }

  async verify(relativePath, expectedChecksum) {
    const lease = await this.acquire(relativePath, expectedChecksum);
    try {
      return publicLeaseMetadata(lease);
    } finally {
      await lease.release();
    }
  }

  async acquire(relativePath, expectedChecksum) {
    const relative = safeRelativePath(relativePath);
    if (relative === LEASE_DIRECTORY || relative.startsWith(`${LEASE_DIRECTORY}/`)) {
      throw coded('invalid_media_path', '发布文件不能来自发布器私有快照目录。');
    }
    const root = await fs.realpath(this.rootPath);
    const absolute = await fs.realpath(path.resolve(root, relative));
    if (!absolute.startsWith(`${root}${path.sep}`)) throw coded('media_path_escape', '发布文件逃逸了受控工作区。');

    const leaseRoot = path.join(root, LEASE_DIRECTORY);
    await fs.mkdir(leaseRoot, { recursive:true, mode:0o700 });
    await fs.chmod(leaseRoot, 0o700);
    const leaseDirectory = await fs.mkdtemp(path.join(leaseRoot, 'lease-'));
    await fs.chmod(leaseDirectory, 0o700);
    const snapshotPath = path.join(leaseDirectory, 'media.snapshot');

    let sourceHandle;
    let snapshotHandle;
    let readHandle;
    try {
      sourceHandle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) throw coded('media_not_regular_file', '发布文件必须是普通文件。');

      snapshotHandle = await fs.open(
        snapshotPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o400,
      );
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let bytes = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await writeAll(snapshotHandle, chunk);
        bytes += bytesRead;
      }
      await snapshotHandle.sync();
      await snapshotHandle.close();
      snapshotHandle = null;
      await sourceHandle.close();
      sourceHandle = null;

      const checksum = `sha256:${hash.digest('hex')}`;
      if (checksum !== expectedChecksum) {
        throw coded('media_checksum_mismatch', '实际发布文件与审核哈希不一致。');
      }

      readHandle = await fs.open(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let released = false;
      return {
        relativePath:relative,
        checksum,
        bytes,
        immutableLease:true,
        createReadStream() {
          if (released) throw coded('media_lease_released', '发布文件私有快照已经释放。');
          return readHandle.createReadStream({ autoClose:false, start:0 });
        },
        async release() {
          if (released) return;
          released = true;
          await readHandle.close().catch(() => undefined);
          await fs.rm(leaseDirectory, { recursive:true, force:true });
        },
      };
    } catch (error) {
      await snapshotHandle?.close().catch(() => undefined);
      await sourceHandle?.close().catch(() => undefined);
      await readHandle?.close().catch(() => undefined);
      await fs.rm(leaseDirectory, { recursive:true, force:true });
      throw error;
    }
  }
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten === 0) throw coded('media_snapshot_write_failed', '发布文件私有快照写入失败。');
    offset += bytesWritten;
  }
}

function publicLeaseMetadata(lease) {
  return {
    relativePath:lease.relativePath,
    checksum:lease.checksum,
    bytes:lease.bytes,
  };
}

function safeRelativePath(value) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (!text || text.startsWith('/') || text.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw coded('invalid_media_path', '发布文件必须是工作区内相对路径。');
  }
  return text;
}
