import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
export class WorkerStateStore {
    readonly filePath: string;

    constructor(filePath: any) { this.filePath = filePath; }
    async read() {
        try {
            const state = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
            return { schemaVersion: 'agent.army/mac-worker-state/v1', activeLease: null, jobs: {}, ...state };
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return { schemaVersion: 'agent.army/mac-worker-state/v1', activeLease: null, jobs: {} };
            throw error;
        }
    }
    async save(state: any) {
        const value = {
            schemaVersion: 'agent.army/mac-worker-state/v1',
            activeLease: state?.activeLease || null,
            jobs: state?.jobs && typeof state.jobs === 'object' ? state.jobs : {}
        };
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, this.filePath);
        return value;
    }
}
