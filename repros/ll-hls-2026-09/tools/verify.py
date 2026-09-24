"""Verify the hosted demo using a ChromeDriver server at 127.0.0.1:4448."""
import json,time,urllib.request,sys
base=sys.argv[1]
endpoint='http://127.0.0.1:4448'
def req(path,data=None,method=None):
 body=None if data is None else json.dumps(data).encode()
 r=urllib.request.Request(endpoint+path,data=body,headers={'Content-Type':'application/json'},method=method)
 with urllib.request.urlopen(r) as response: return json.load(response)['value']
sid=req('/session',{'capabilities':{'alwaysMatch':{'browserName':'chrome','goog:chromeOptions':{'args':['--headless=new','--autoplay-policy=no-user-gesture-required']}}}})['sessionId']
results=[]
try:
 for case in ['tail','subtitles','tracker','loading','playback']:
  for build in ['upstream','patched']:
   req('/session/'+sid+'/url',{'url':base+'?case='+case+'&build='+build+'&auto=1'})
   deadline=time.monotonic()+48
   result=None
   while time.monotonic()<deadline:
    result=req('/session/'+sid+'/execute/sync',{'script':'return window.reproResult || null','args':[]})
    if result: break
    time.sleep(.25)
   row={'case':case,'build':build,'result':result};results.append(row);print(json.dumps(row),flush=True)
finally:
 req('/session/'+sid,method='DELETE')
if any(r['result'] is None or 'error' in r['result'] or (r['build']=='patched' and not r['result']['passed']) or (r['case']!='playback' and r['build']=='upstream' and r['result']['passed']) for r in results):sys.exit(1)
