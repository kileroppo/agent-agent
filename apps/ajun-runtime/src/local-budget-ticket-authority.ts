import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSignedBudgetTicket } from '@agent-army/paperclip-content-autonomy/signed-budget-ticket';

let cachedAuthority: LocalBudgetTicketAuthority | null = null;

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
        if (cachedAuthority) return cachedAuthority;
        const absolute: any = path.resolve(String(privateKeyPath || ''));
        const publicKeyPath: any = `${absolute}.pub`;
        let privateKey: any;
        try {
            privateKey = await fs.readFile(absolute, 'utf8');
        }
        catch {
            const pair: any = crypto.generateKeyPairSync('ed25519');
            privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
            const publicKey: any = pair.publicKey.export({ type: 'spki', format: 'pem' });
            try {
                await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
                await fs.writeFile(absolute, privateKey, { mode: 0o600 });
                await fs.writeFile(publicKeyPath, publicKey, { mode: 0o644 });
            } catch { /* In-memory fallback */ }
        }
        const publicKey: any = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
        cachedAuthority = new LocalBudgetTicketAuthority({ privateKey, publicKey, publicKeyPath });
        return cachedAuthority;
    }
    sign(input: any): any {
        return createSignedBudgetTicket({ ...input, privateKey: this.privateKey });
    }
}
