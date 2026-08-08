import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export function createMutationSerializer() {
  let pending = Promise.resolve();
  return (operation) => {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
}

export async function hardenPrivateFile(file) {
  await fs.chmod(file, 0o600);
}

export async function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag:'wx',
      mode:0o600,
    });
    await fs.rename(temporary, file);
    await hardenPrivateFile(file);
  } catch (error) {
    await fs.rm(temporary, { force:true }).catch(() => {});
    throw error;
  }
}
