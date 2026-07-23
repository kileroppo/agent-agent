import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class TechnicalRepairPromotion {
  constructor({ projectRoot, fsImpl = fs } = {}) { this.projectRoot = path.resolve(projectRoot || process.cwd()); this.fs = fsImpl; }

  async promote(task, evidence) {
    const proof = evidence?.metadata?.agentArmyRepairEvidence;
    const workspace = String(task.execution?.workspace?.path || '');
    const allowedFiles = repairFiles(task);
    const changedFiles = Array.isArray(proof?.changedFiles) ? proof.changedFiles.map((item) => String(item || '').trim()).filter(Boolean) : [];
    if (!workspace || proof?.testsPassed !== true || proof?.recoveryVerified !== true || !changedFiles.length || changedFiles.some((item) => !allowedFiles.includes(item))) return { status:'rejected', reason:'修复结果缺少完整证据，或改动超出允许范围。' };
    let snapshot;
    try { snapshot = JSON.parse(await this.fs.readFile(path.join(workspace, '.agent-army-repair-snapshot.json'), 'utf8')); }
    catch { return { status:'rejected', reason:'缺少修理房创建时的原始记录。' }; }
    const candidates = [];
    for (const relativePath of changedFiles) {
      const source = path.join(this.projectRoot, relativePath); const candidate = path.join(workspace, relativePath);
      const expected = snapshot.files?.[relativePath]?.sourceHash;
      if (!expected) return { status:'rejected', reason:'修理房没有记录该文件的原始状态。' };
      const current = await this.fs.readFile(source);
      if (hash(current) !== expected) return { status:'conflict', reason:`主工程中的 ${relativePath} 已被其他改动更新，未覆盖。` };
      candidates.push({ source, content:await this.fs.readFile(candidate) });
    }
    for (const candidate of candidates) await this.fs.writeFile(candidate.source, candidate.content);
    return { status:'promoted', changedFiles };
  }
}

function repairFiles(task) {
  return Array.isArray(task?.input?.context?.repairScope?.files) ? task.input.context.repairScope.files.map((item) => String(item || '').trim()).filter((item) => item && !path.isAbsolute(item) && !item.split('/').includes('..')) : [];
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
