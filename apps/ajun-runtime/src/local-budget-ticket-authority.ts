import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSignedBudgetTicket } from '@agent-army/paperclip-content-autonomy/signed-budget-ticket';

export class LocalBudgetTicketAuthority {
    privateKey: any;
    publicKey: any;
    publicKeyPath: any;
    constructor({ privateKey, publicKey, publicKeyPath }: any) {
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.publicKeyPath = publicKeyPath;
    }
    static async open(privateKeyPath: any): Promise<any> {
        const absolute: any = path.resolve(String(privateKeyPath || ''));
        if (!absolute) throw new Error('预算票据密钥路径无效。');
        const publicKeyPath: any = `${absolute}.pub`;
        let privateKey: any;
        try {
            const stat: any = await fs.lstat(absolute);
            if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
                throw new Error('预算票据私钥必须是 0600 普通文件。');
            }
            privateKey = await fs.readFile(absolute, 'utf8');
        }
        catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
            await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
            const pair: any = crypto.generateKeyPairSync('ed25519');
            privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
            const publicKey: any = pair.publicKey.export({ type: 'spki', format: 'pem' });
            await fs.writeFile(absolute, privateKey, { mode: 0o600 });
            await fs.writeFile(publicKeyPath, publicKey, { mode: 0o644 });
        }
        const publicKey: any = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
        try {
            const current: any = await fs.readFile(publicKeyPath, 'utf8');
            if (current !== publicKey) throw new Error('预算票据公钥与私钥不匹配。');
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
            await fs.writeFile(publicKeyPath, publicKey, { mode: 0o644 });
        }
        return new LocalBudgetTicketAuthority({ privateKey, publicKey, publicKeyPath });
    }
    sign(input: any): any {
        return createSignedBudgetTicket({ ...input, privateKey: this.privateKey });
    }
}
