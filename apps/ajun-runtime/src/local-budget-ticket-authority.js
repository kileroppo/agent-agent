import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSignedBudgetTicket } from '@agent-army/paperclip-content-autonomy/signed-budget-ticket';

export class LocalBudgetTicketAuthority {
  constructor({ privateKey, publicKey, publicKeyPath }) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.publicKeyPath = publicKeyPath;
  }

  static async open(privateKeyPath) {
    const absolute = path.resolve(String(privateKeyPath || ''));
    if (!absolute) throw new Error('预算票据密钥路径无效。');
    const publicKeyPath = `${absolute}.pub`;
    let privateKey;
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error('预算票据私钥必须是 0600 普通文件。');
      }
      privateKey = await fs.readFile(absolute, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await fs.mkdir(path.dirname(absolute), { recursive:true, mode:0o700 });
      const pair = crypto.generateKeyPairSync('ed25519');
      privateKey = pair.privateKey.export({ type:'pkcs8', format:'pem' });
      const publicKey = pair.publicKey.export({ type:'spki', format:'pem' });
      await exclusiveWrite(absolute, privateKey, 0o600);
      await exclusiveWrite(publicKeyPath, publicKey, 0o644);
    }
    const publicKey = crypto.createPublicKey(privateKey).export({ type:'spki', format:'pem' });
    await ensurePublicKey(publicKeyPath, publicKey);
    return new LocalBudgetTicketAuthority({ privateKey, publicKey, publicKeyPath });
  }

  sign(input) {
    return createSignedBudgetTicket({ ...input, privateKey:this.privateKey });
  }
}

async function exclusiveWrite(file, value, mode) {
  const handle = await fs.open(file, 'wx', mode);
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
}

async function ensurePublicKey(file, expected) {
  try {
    const current = await fs.readFile(file, 'utf8');
    if (current !== expected) throw new Error('预算票据公钥与私钥不匹配。');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await exclusiveWrite(file, expected, 0o644);
  }
}
