// Runs server tests against an in-memory Blob mock. Usage: node test/run.mjs
import { mkdirSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'node_modules/@vercel/blob');
const real = path.join(root, 'node_modules/@vercel/blob/package.json');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(path.join(root, 'test/mock-blob'), dest, { recursive: true });
const env = { ...process.env, AUTH_SECRET: 'test', USER_PINS: JSON.stringify({ Loriale: '11111111', Ben: '22222222', Mayer: '33333333' }),
  CRON_SECRET: 'cronsecret', ADMIN_PASSWORD: 'adminpass1', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+18455550100' };
try {
  for (const MODE of ['normal', 'weak', 'diff']) {
    console.log('== etag mode:', MODE);
    console.log(execFileSync('node', ['test/server.test.mjs'], { cwd: root, env: { ...env, MODE } }).toString());
    console.log(execFileSync('node', ['test/tickets.test.mjs'], { cwd: root, env: { ...env, MODE } }).toString());
    console.log(execFileSync('node', ['test/users.test.mjs'], { cwd: root, env: { ...env, MODE } }).toString());
  }
} finally {
  rmSync(dest, { recursive: true, force: true });
  console.log('(mock removed — run `npm install` before `vercel dev`)');
}
