import { access, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 17)) {
  console.error('RestockPilot needs Node.js 22.17 or newer.'); process.exit(1);
}
const env = new URL('../.env', import.meta.url);
try { await access(env); console.log('Existing .env preserved.'); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await copyFile(new URL('../.env.example', import.meta.url), env, constants.COPYFILE_EXCL);
  console.log('Created .env from .env.example.');
}
console.log('Run npm start, then open http://127.0.0.1:4318.');
console.log('Calculated preview needs no account. Real AI and sandbox checkout require the connections described in README.');
