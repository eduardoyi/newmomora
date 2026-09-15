from pathlib import Path
import tempfile,subprocess,os,hashlib,time
src=(Path(__file__).parent.parent/'kindle/frame.sh').read_text()
for mode in ['success','download_failure','bad_hash','charging','early_gui_term']:
 with tempfile.TemporaryDirectory() as tmp:
  p=Path(tmp);(p/'rtc').write_text('0');(p/'power').write_text('')
  def tool(name,body):
   f=p/name;f.write_text('#!/bin/sh\n'+body);f.chmod(0o755)
  gen='12345678-1234-1234-1234-123456789abc';data=b'image fixture';sha=hashlib.sha256(data).hexdigest();now=int(time.time())
  (p/'fixture').write_bytes(data)
  manifest=f'FRAME1 {now} {now+80000} {gen} 2026.09.09-10:00:00\n'+''.join(f'IMAGE {i} {sha if mode!="bad_hash" else "f"*64} /image/{gen}/{i}\n' for i in range(1,6))+''.join(f'AT {now+i*3600} {i}\n' for i in range(1,6))+'END\n'
  (p/'fixture-manifest').write_text(manifest)
  (p/'cloud.conf').write_text("FRAME_URL=https://fixture.workers.dev\nFRAME_TOKEN="+'a'*64+'\nBOOTSTRAP_EPOCH=0\n')
  tool('xh','exit 1' if mode=='download_failure' else f'case "$*" in */manifest*) cat "{p}/fixture-manifest";; *) cat "{p}/fixture";; esac')
  tool('lipc-get-prop','case "$2" in cmState) echo CONNECTED;;isCharging) echo '+('1' if mode=='charging' else '0')+';;*)echo 0;;esac')
  tool('lipc-set-prop','exit 0');tool('sleep','exit 0');tool('sync','exit 0')
  tool('date',f'echo {now}')
  tool('fbink',f'echo image >> "{p}/renders"')
  tool('initctl',f'if [ "$1" = status ];then echo start/running;else echo "$1" >> "{p}/gui";fi\n'+('if [ "$1" = stop ];then kill -TERM "$PPID";fi' if mode=='early_gui_term' else ''))
  s=src.replace('/mnt/us/extensions/momora-frame',tmp).replace('/sys/devices/platform/mxc_rtc.0/wakeup_enable',tmp+'/rtc').replace('/tmp/momora-hardware-test.lock',tmp+'/lock').replace('/sbin/initctl',tmp+'/initctl').replace('/sys/power/state',tmp+'/power')
  (p/'run').write_text(s)
  result=subprocess.run(['sh',str(p/'run'),'test'],env={**os.environ,'PATH':tmp+':'+os.environ['PATH']},timeout=15)
  assert not (p/'lock').exists()
  if mode in ['success','early_gui_term']:
   assert result.returncode==0,(mode,(p/'cloud.log').read_text())
   assert len((p/'renders').read_text().splitlines())==2
   assert (p/'gui').read_text().splitlines()==['stop','start']
   assert (p/'cloud-cache/current').read_text().strip()==gen
  else:
   assert result.returncode!=0
   assert not (p/'renders').exists()
   assert not (p/'cloud-cache/current').exists()
print('Passed: verified batch + 2 renders, network/hash/USB guards, GUI TERM, cleanup.')
