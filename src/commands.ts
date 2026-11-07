import { resolve } from 'node:path';

export function commandHint(message: string, env = process.env, cwd = process.cwd()): string {
  if (env.npm_command !== 'exec') return message;
  const pkg = env.npm_config_package;
  let command: string;
  if (pkg && /^https:\/\/github\.com\/vercel-labs\/rex-cloud\/releases\/download\/[A-Za-z0-9._-]+\/vercel-labs-rex-cloud-[A-Za-z0-9._-]+\.tgz$/.test(pkg)) {
    command = `npx --yes --package '${pkg}' rex-cloud`;
  } else if (pkg?.endsWith('.tgz') && !/^https?:\/\//.test(pkg) && /(?:^|\/)vercel-labs-rex-cloud-[^/]+\.tgz$/.test(pkg)) {
    const path = resolve(cwd, pkg).replaceAll("'", "'\\''");
    command = `npx --yes --package '${path}' rex-cloud`;
  } else if (!pkg || /^@vercel-labs\/rex-cloud(?:@[A-Za-z0-9.+-]+)?$/.test(pkg)) {
    command = `npx --yes ${pkg || '@vercel-labs/rex-cloud'}`;
  } else return message;
  return message.replace(/\brex-cloud (?=(?:start|up|open|status|extend|stop|disconnect|setup|login|--help)(?:\s|$|[.,]))/g, `${command} `);
}
