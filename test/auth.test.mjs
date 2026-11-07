import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';

test('bundled refresh preserves login on failure and metadata on success, without proactive network refresh', async t => {
  const root = await mkdtemp('/tmp/rex-auth-fixture-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, XDG_DATA_HOME: root, REX_AUTH_FIXTURE: root };
  delete env.VERCEL_TOKEN;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {mkdir,writeFile,readFile} from 'node:fs/promises';
    import {getGlobalPathConfig} from '@vercel/cli-config';
    import {token} from './dist/auth.js';
    import {join} from 'node:path';
    const dir=getGlobalPathConfig();
    assert.ok(dir.startsWith(process.env.REX_AUTH_FIXTURE+'/'));
    await mkdir(dir,{recursive:true});const path=join(dir,'auth.json');
    const original={token:'expired-fixture',refreshToken:'refresh-fixture',expiresAt:1,userId:'fixture-user',cachedUser:{id:'fixture-user',username:'fixture'}};
    let mode='offline',requests=0;
    globalThis.fetch=async url=>{
      requests++;
      if(mode==='offline')throw new Error('synthetic network unavailable');
      if(String(url).includes('openid-configuration'))return Response.json({token_endpoint:'https://vercel.com/fixture-token'});
      if(mode==='denied')return Response.json({error:'invalid_grant'},{status:400});
      if(mode==='malformed')return Response.json({});
      return Response.json({access_token:'new-fixture',expires_in:3600,token_type:'Bearer'});
    };
    for(mode of ['offline','denied','malformed']){
      await writeFile(path,JSON.stringify(original),{mode:0o600});
      const before=await readFile(path);
      await assert.rejects(token(),/saved login was preserved/);
      assert.deepEqual(await readFile(path),before);
    }
    mode='success';await writeFile(path,JSON.stringify(original));
    const result=await Promise.all([token(),token()]);assert.deepEqual(result,['new-fixture','new-fixture']);
    const saved=JSON.parse(await readFile(path));
    assert.equal(saved.refreshToken,original.refreshToken);assert.equal(saved.userId,original.userId);assert.deepEqual(saved.cachedUser,original.cachedUser);
    mode='offline';const before=requests;assert.equal(await token(),'new-fixture');assert.equal(requests,before);
  `], { cwd: process.cwd(), env, stdio: 'pipe' });
});
