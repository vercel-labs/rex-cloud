import { AccessTokenMissingError, getVercelToken } from '@vercel/oidc';
import { spawn } from 'node:child_process';

let pending: Promise<string> | undefined;
export const LOGIN_ARGS = ['--yes', '--package', 'vercel@62.5.0', 'vercel', 'login'];
export class SignInRequired extends Error {}
export function token(): Promise<string> {
  if (process.env.VERCEL_TOKEN) return Promise.resolve(process.env.VERCEL_TOKEN);
  pending ??= getVercelToken().catch(error => {
    if (error instanceof AccessTokenMissingError) throw new SignInRequired('Vercel sign-in is required. Run rex-cloud login, then reopen your computer.');
    throw new Error('Vercel authentication could not refresh. Your saved login was preserved. Check your connection and retry. If access was revoked, run rex-cloud login.');
  }).finally(() => { pending = undefined; });
  return pending;
}
export async function login(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', LOGIN_ARGS, { stdio: 'inherit', shell: false });
    child.on('error', () => reject(new Error('Could not start Vercel login. Install Node.js and npm, then run rex-cloud login.')));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Vercel login did not complete.')));
  });
  await token();
}
export async function authenticate(interactive: boolean): Promise<void> {
  try { await token(); }
  catch (e) { if (!interactive || !(e instanceof SignInRequired)) throw e; await login(); }
}
