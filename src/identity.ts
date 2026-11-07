import { createHash } from 'node:crypto';
import { token } from './auth.js';
import { validateName, type Scope } from './state.js';

export interface Identity extends Scope { userId: string; shared: boolean }
export async function currentUser(request: typeof fetch = fetch): Promise<string> {
  const response = await request('https://api.vercel.com/v2/user', {
    headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Could not verify your Vercel user (HTTP ${response.status}). Check your connection or run rex-cloud login.`);
  const data = await response.json() as { user?: { id?: unknown } };
  if (typeof data.user?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.user.id)) throw new Error('Vercel returned an invalid user identity.');
  return data.user.id;
}
export function cloudName(scope: Partial<Identity>, name: string): string {
  validateName(name);
  if (scope.shared === true) return `rex-cloud-${name}`;
  if (!scope.userId || !/^[A-Za-z0-9_-]{1,128}$/.test(scope.userId)) throw new Error('Personal computers require a verified Vercel user. Run start again.');
  const user = createHash('sha256').update(scope.userId).digest('hex').slice(0, 16);
  return `rex-cloud-${user}-${name}`;
}
