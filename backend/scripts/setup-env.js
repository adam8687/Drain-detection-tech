// Safe to rerun: existing credentials are never replaced.
import { copyFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';

const root = new URL('../../', import.meta.url);
for (const [example, target] of [['backend/.env.example', 'backend/.env'], ['web/.env.example', 'web/.env.local']]) {
  try {
    await copyFile(new URL(example, root), new URL(target, root), constants.COPYFILE_EXCL);
    await chmod(new URL(target, root), 0o600);
    console.log(`Created ${target}. Fill required values before starting.`);
  } catch (error) {
    if (error.code === 'EEXIST') console.log(`Kept existing ${target} unchanged.`);
    else { console.error(`Could not create ${target}. Check file permissions.`); process.exitCode = 1; }
  }
}
