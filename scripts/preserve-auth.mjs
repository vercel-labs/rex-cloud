import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function preserveAuth(source) {
  const supported = new Set(['8e97aa545bb77fc664867e83dd569b982ab76f797f2588f0d128da5b477626b0', '0b750fc022624cdd0b6308fa2e0dad1e47e304422fe0f8f61dafc727eb8059ec']);
  if (!supported.has(createHash('sha256').update(source).digest('hex'))) {
    throw new Error('Review the @vercel/oidc auth-preservation patch before changing its version.');
  }
  // Pinned @vercel/oidc 4.0.0/4.0.5 clear the shared CLI login on refresh errors, including network failures.
  return source.replaceAll('(0, import_cli_config.writeAuthConfig)(configDir, {});', '')
    .replace('const updatedConfig = {\n      token:', 'const updatedConfig = {\n      ...authConfig,\n      token:')
    .replace('refreshToken: tokens.refresh_token', 'refreshToken: tokens.refresh_token ?? authConfig.refreshToken');
}

export const preserveAuthPlugin = {
  name: 'preserve-vercel-login',
  setup(build) {
    build.onLoad({ filter: /@vercel\/oidc\/dist\/token-util\.js$/ }, async ({ path }) => ({
      contents: preserveAuth(await readFile(path, 'utf8')), loader: 'js',
    }));
  },
};
