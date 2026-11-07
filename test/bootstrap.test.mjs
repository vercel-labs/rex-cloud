import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('bootstrap verifies existing binary and restores an empty session with a new terminal', () => {
  execFileSync('python3', ['-c', `
import runpy,tempfile,pathlib,hashlib,unittest.mock as mock
main=runpy.run_path('assets/bootstrap.py')['main']; g=main.__globals__
with tempfile.TemporaryDirectory() as tmp:
 home=pathlib.Path(tmp);root=home/'.local/share/rex-cloud';root.mkdir(parents=True)
 binary=root/'rex';binary.write_bytes(b'verified fixture')
 g['BINARY_SHA256']=hashlib.sha256(binary.read_bytes()).hexdigest()
 calls=[]
 def run(rex,*args):
  calls.append(args)
  if args[0]=='version':return {'api_revision':10}
  if args[:2]==('server','start'):return {'endpoint':'unix:///tmp/rex.sock'}
  if args[:2]==('session','ls'):return {'sessions':[{'label':'test','session_id':'session:test'}]}
  if args[:2]==('session','inspect'):return {'windows':[]}
  if args[:2]==('block','ls'):return {'blocks':[]}
  if args[:2]==('window','new'):return {'block_ids':['block:fresh']}
  raise AssertionError(args)
 g['run']=run
 with mock.patch('pathlib.Path.home',return_value=home),mock.patch('platform.system',return_value='Linux'),mock.patch('platform.machine',return_value='x86_64'),mock.patch('sys.argv',['bootstrap','test','0','10']),mock.patch('urllib.request.urlopen',side_effect=RuntimeError('download requested')) as fetch:
  main();assert any(a[:2]==('window','new') for a in calls);assert not fetch.called
  binary.write_bytes(b'old version')
  try:main();raise AssertionError('old binary accepted')
  except RuntimeError as e:assert str(e)=='download requested'
  assert fetch.called
`]);
});
