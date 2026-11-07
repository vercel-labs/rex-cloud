import { createInterface } from 'node:readline/promises';
import { token } from './auth.js';
import { duration } from './state.js';

export async function teamLimit(teamId: string, request: typeof fetch = fetch): Promise<number> {
  const r = await request(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
    headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Could not check your team's Sandbox duration limit (HTTP ${r.status}).`);
  const data = await r.json() as { billing?: { plan?: string } };
  if (data.billing?.plan === 'hobby') return duration('45m');
  if (['pro', 'enterprise'].includes(data.billing?.plan ?? '')) return duration('24h');
  throw new Error('Your team plan could not be determined. Check it in Vercel before choosing a duration.');
}
export async function chooseLifetime(teamId: string, explicit: string | undefined, saved: string | undefined, interactive: boolean, request: typeof fetch = fetch): Promise<string> {
  const chosen = explicit ?? saved;
  if (!chosen && !interactive) throw new Error('Choose a duration with --timeout, for example --timeout 45m or --timeout 8h. Running computers incur usage.');
  const limit = await teamLimit(teamId, request);
  if (chosen) {
    if (duration(chosen) > limit) throw new Error('That duration exceeds your team plan limit. Hobby supports up to 45m; Pro and Enterprise up to 24h.');
    return chosen;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(`\nHow long should it run? (max ${limit === duration('45m') ? '45m' : '24h'})\nKeeps running when you close your laptop.\n`);
  try {
    while (true) {
      const answer = (await rl.question('Duration (m = minutes, h = hours): ')).trim();
      try { if (duration(answer) <= limit) return answer; } catch {}
      process.stderr.write('Enter a duration with m for minutes or h for hours, within your plan limit.\n');
    }
  } finally { rl.close(); }
}
