"""Capture synthetic Rushls playlist updates and referenced media for static replay."""
import concurrent.futures, json, os, re, subprocess, time, urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlparse
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--repo',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
a=parser.parse_args(); a.output.mkdir(parents=True,exist_ok=True)
ready=a.output.resolve()/'capture.ready'
for ext in ['ready','start','done','outcome']: ready.with_suffix('.'+ext).unlink(missing_ok=True)
env={**os.environ,'RUSHLS_GAP_LIVE_READY':str(ready),'RUSHLS_GAP_LIVE_CONTROL':'1'}
log=(a.output/'capture.log').open('w')
process=subprocess.Popen(['cargo','test','--locked','--lib','live_av_gap_browser_origin','--','--ignored','--nocapture'],cwd=a.repo,env=env,stdout=log,stderr=subprocess.STDOUT)
snapshots={}; media=set(); futures={}
def fetch(url):
 with urllib.request.urlopen(url,timeout=4) as r: return r.read()
def save(url):
 data=fetch(url); rel=urlparse(url).path.split('/live/gap-probe/',1)[1]
 p=a.output/'media'/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
 return rel
try:
 deadline=time.monotonic()+60
 while not ready.exists():
  if time.monotonic()>deadline: raise RuntimeError('Origin did not start')
  time.sleep(.1)
 master=ready.read_text().strip(); origin=master.rsplit('/',1)[0]+'/'
 ready.with_suffix('.start').touch(); start=time.monotonic()
 with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
  end_seen=False
  while time.monotonic()-start<35:
   elapsed=round(time.monotonic()-start,3)
   for path in ['index.m3u8','0/video.m3u8','1/video.m3u8','2/audio.m3u8','3/audio.m3u8']:
    try: body=fetch(origin+path).decode()
    except Exception: continue
    if path=='index.m3u8': body='\n'.join(line for line in body.splitlines() if not line.startswith('#EXT-X-I-FRAME-STREAM-INF:'))+'\n'
    entries=snapshots.setdefault(path,[])
    if not entries or entries[-1]['body']!=body: entries.append({'at':elapsed,'body':body})
    for line in body.splitlines():
     if line.startswith('#EXT-X-PRELOAD-HINT'): continue
     uris=re.findall(r'URI="([^"]+)"',line) if line.startswith('#') else [line.strip()]
     for uri in uris:
      if not uri or '.m3u8' in uri: continue
      url=urljoin(origin+path,uri)
      if url not in futures: futures[url]=pool.submit(save,url)
   if ready.with_suffix('.outcome').exists():
    if end_seen: break
    end_seen=True
   time.sleep(.08)
  for url,future in futures.items():
   try: media.add(future.result())
   except Exception:
    # A referenced object can become ready just after its snapshot was captured.
    media.add(save(url))
 (a.output/'snapshots.json').write_text(json.dumps({'snapshots':snapshots,'media':sorted(media)},separators=(',',':'))+'\n')
 for path,entries in snapshots.items():
  p=a.output/'media'/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(entries[-1]['body'])
 print(f'Captured {sum(map(len,snapshots.values()))} snapshots and {len(media)} media files')
finally:
 ready.with_suffix('.done').touch()
 try: process.wait(timeout=15)
 except subprocess.TimeoutExpired: process.terminate();process.wait()
 log.close()
