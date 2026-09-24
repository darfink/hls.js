const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
$('scenario').value = query.get('case') || 'tail';
$('build').value = query.get('build') || 'upstream';
let player, timer;
const write = value => $('log').textContent += JSON.stringify(value, null, 2) + '\n';
const parse = (m, text, type='main') => m.M3U8Parser.parseLevelPlaylist(text, new URL('excerpts/media.m3u8', location.href).href, 0, type, 0, null);
const text = name => fetch(`excerpts/${name}.m3u8`).then(r => r.text());
function finish(actual, expected, details) {
  const passed = actual === expected;
  window.reproResult = {passed,actual,expected,details};
  $('result').textContent = `${passed ? 'PASS' : 'BUG REPRODUCED'} — expected ${expected}; observed ${actual}`;
  write(window.reproResult);
}
async function stateCase(m, name) {
  player = new m.Hls({autoStartLoad:false,enableWorker:false});
  const h = player, c = h.streamController, tracker = c.fragmentTracker;
  if (name === 'tail') {
    $('description').textContent = 'A 21.333 ms audio tail is unloaded. Earlier parts are loaded; fragment selection has clamped the target to the following parent’s start.';
    const d = parse(m, await text('tail'), 'audio');
    d.partList.slice(0,4).forEach(p => p.elementaryStreams.audio = {});
    const index = c.getNextPart(d.partList, d.partList[5].fragment, d.partList[5].start);
    finish(index,4,{selected:d.partList[index]?.relurl,tail:d.partList[4].relurl,target:d.partList[5].start});
  } else if (name === 'subtitles') {
    $('description').textContent = 'Deliver a delta response after captions are disabled. Its skipped-segment placeholders must not be cached or aligned; then reselect captions and deliver a fresh delta.';
    const previous = parse(m, await text('subtitles-full'),'subtitle');
    const deltaText = await text('subtitles-delta');
    const track = {id:0,groupId:'subs',name:'English',url:new URL('excerpts/subtitles-full.m3u8',location.href).href,details:previous};
    const tc=h.subtitleTrackController, sc=h.networkControllers.filter(x=>x instanceof m.SubtitleStreamController)[0];
    tc.tracksInGroup=[track];tc.trackId=-1;tc.currentTrack=null;
    sc.levels=[{id:0,details:previous}];sc.currentTrackId=-1;sc.mainDetails=previous;
    const errors=[];h.on(m.Events.ERROR,(_,e)=>errors.push({details:e.details,message:String(e.error)}));
    const deliver=details=>h.trigger(m.Events.SUBTITLE_TRACK_LOADED,{id:0,groupId:'subs',details,track,stats:new m.LoadStats(),networkDetails:null,deliveryDirectives:null});
    deliver(parse(m,deltaText,'subtitle'));
    const preserved=track.details===previous && sc.levels[0].details===previous;
    tc.trackId=0;tc.currentTrack=track;sc.currentTrackId=0;
    const resumed=parse(m,deltaText,'subtitle');deliver(resumed);
    finish(errors.length===0 && preserved && resumed.fragments[0]?.sn===100,true,{errors,preserved,resumedFirstSequence:resumed.fragments[0]?.sn});
  } else if (name === 'tracker') {
    $('description').textContent = 'A parent was complete at 1.8 seconds, then its advertised duration grows to 2 seconds. Buffer padding must not hide the missing 200 ms tail.';
    const d=parse(m,await text('final-ended')), frag=d.fragments[0], first=d.partList[0];
    frag.setElementaryStreamInfo('video',0,2,0,2);frag.duration=1.8;
    h.trigger(m.Events.FRAG_LOADED,{frag,part:null,payload:new ArrayBuffer(0),networkDetails:null});
    const ranges={length:1,start:()=>0,end:()=>1.8};
    h.trigger(m.Events.BUFFER_APPENDED,{chunkMeta:new m.ChunkMetadata(0,0,0,0),frag,part:null,parent:'main',type:'video',timeRanges:{video:ranges}});
    h.trigger(m.Events.FRAG_BUFFERED,{frag,part:first,stats:new m.LoadStats(),id:'main'});
    const before=tracker.getState(frag);frag.duration=2;
    finish(tracker.getState(frag),'PARTIAL',{before,buffer:[0,1.8],advertised:[0,2]});
  } else {
    $('description').textContent = 'ENDLIST arrives while the final advertised 200 ms part is still unloaded. The previous parent must remain eligible for loading.';
    const d=parse(m,await text('final-ended')), frag=d.fragments[0];
    d.partList[0].elementaryStreams.video={};
    c.loadingParts=true;c.fragPrevious=frag;c.lastCurrentTime=0;
    tracker.getState=()=> 'PARTIAL';
    const selected=c.getFragmentAtPosition(1.8,2,d);
    finish(selected?.sn ?? null,frag.sn,{bufferEnd:1.8,mediaEnd:2,endlist:!d.live,selected:selected?.sn??null,expected:frag.sn});
  }
}
async function playback(m) {
  $('description').textContent = '24 seconds of real captured synthetic A/V. A custom loader replays changing playlists and ENDLIST; four timed rendition switches use normal player APIs. Allow 40 seconds. This compares upstream with all four patches together, not each patch’s isolated playback effect.';
  $('video').hidden=false;
  const data=await fetch('assets/snapshots.json').then(r=>r.json());
  const epoch=performance.now();const root=new URL('assets/media/',location.href);
  const Base=m.Hls.DefaultConfig.loader;
  class ReplayLoader extends Base {
    load(context,config,callbacks) {
      const key=new URL(context.url).pathname.split('/replay/')[1];
      const records=data.snapshots[key];
      if(!records) return super.load({...context,url:new URL(key,root).href},config,callbacks);
      this.context=context;
      const elapsed=(performance.now()-epoch)/1000+0.8;
      const snapshot=records.filter(r=>r.at<=elapsed).at(-1)||records[0];
      this.stats.loading.start=performance.now();
      this.pending=setTimeout(()=>{
        this.stats.loading.first=this.stats.loading.end=performance.now();
        this.stats.loaded=this.stats.total=snapshot.body.length;
        callbacks.onSuccess({url:context.url,data:snapshot.body,code:200},this.stats,context,null);
      },80);
    }
    abort(){clearTimeout(this.pending);super.abort();}
    destroy(){clearTimeout(this.pending);super.destroy();}
  }
  player=new m.Hls({loader:ReplayLoader,enableWorker:false,startPosition:0,startLevel:0,lowLatencyMode:true});
  const h=player,v=$('video'),errors=[],switches=[];
  h.on(m.Events.ERROR,(_,e)=>{if(e.fatal)errors.push(e.details);});
  const planned=[['audio',7.8,1],['video',10,1],['audio',13.2,0],['video',16,0]];
  v.ontimeupdate=()=>{for(const s of planned){if(!s.done&&v.currentTime>=s[1]){s.done=true;let index=s[2];if(s[0]==='audio')h.audioTrack=index;else{if(h.currentLevel===index)index=1-index;h.nextLevel=index;}switches.push({kind:s[0],time:v.currentTime,index});}}};
  h.on(m.Events.MANIFEST_PARSED,()=>v.play().catch(e=>write(String(e))));
  v.onended=()=>{clearTimeout(timer);finish(errors.length===0,true,{ended:true,time:v.currentTime,switches,errors});};
  h.attachMedia(v);h.loadSource(new URL('replay/index.m3u8',location.href).href);
  timer=setTimeout(()=>finish(false,true,{ended:v.ended,time:v.currentTime,duration:v.duration,switches,errors,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])}),40000);
}
async function run(){
 clearTimeout(timer);if(player)player.destroy();$('video').pause();$('video').removeAttribute('src');$('video').load();$('video').hidden=true;$('log').textContent='';window.reproResult=null;
 $('result').textContent='Running…';
 const name=$('scenario').value,build=$('build').value;
 history.replaceState(null,'',`?case=${name}&build=${build}`);
 try {const m=await import(`./builds/${build==='upstream'?'upstream':name==='playback'?'combined':name}.mjs`);if(name==='playback')await playback(m);else await stateCase(m,name);}
 catch(e){window.reproResult={error:String(e),stack:e.stack};$('result').textContent='Harness error — not a reproduced player failure';write(window.reproResult);}
}
$('run').onclick=run;
if(query.get('auto')==='1')run();
