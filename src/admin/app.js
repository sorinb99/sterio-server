const $ = id => document.getElementById(id);
let expires=0,refreshing=false,deviceSignature='',toolsLoaded=false,toolsAt=0,toolArtists=[],toolItems=[],artworkRunning=false;
async function api(path,body) {
  const response=await fetch('/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error);
  return result;
}
const number=value=>new Intl.NumberFormat('en-US').format(value);
async function refresh(silent=false) {
  if(refreshing || document.hidden) return;
  refreshing=true;
  try {
    await refreshMac();
    const s=await api('status');$('server-name').textContent=s.name;
    $('stats').replaceChildren(...[['Albums',s.albums],['Artists',s.artists],['Tracks',s.tracks],['Paired devices',s.devices]].map(([label,value])=>{const card=document.createElement('div');card.className='stat';const strong=document.createElement('strong');strong.textContent=number(value);const text=document.createElement('span');text.textContent=label;card.append(strong,text);return card;}));
    $('scan').disabled=s.scan.running;$('scan').textContent=s.scan.running?'Scanning…':'Scan library';
    $('scan-state').textContent=s.scan.running?`${number(s.scan.scanned)} files checked · ${s.scan.errors} errors`:`${s.scan.lastFinished?'Last completed '+new Date(s.scan.lastFinished).toLocaleString():'Waiting for first scan'} · ${s.scan.errors} errors`;
    $('system').textContent=`Server ${s.version} · ${number(s.files)} audio files · ${(s.bytes/1024**3).toFixed(1)} GB indexed · ${(s.memory/1024**2).toFixed(0)} MB memory · Uptime ${Math.floor(s.uptime/3600)}h ${Math.floor(s.uptime%3600/60)}m`;
    await refreshLive();
    await refreshReport();
    await refreshSplit();
    await refreshPeers();
    await refreshRequests();
    await refreshRenderers();
    if(!toolsLoaded)await loadLibraryTools();
    if($('artwork-tools').open && Date.now()-toolsAt>5000)await refreshArtworkTools();
    $('message').textContent='';
  } catch(error) {if(!silent)$('message').textContent=error.message;} finally {refreshing=false;}
}
$('scan').onclick=async()=>{$('scan').disabled=true;try{await api('scan',{});await refresh();}catch(error){$('message').textContent=error.message;$('scan').disabled=false;}};
async function refreshSplit(){
  const s=await api('split'),j=s.status;
  $('split').disabled=j.running;$('split').textContent=j.running?(j.force?'Re-splitting…':'Splitting…'):'Split albums into tracks';$('split-force').hidden=j.running;$('split-stop').hidden=!j.running;
  const progress=j.running?`${j.done} of ${j.total} albums${j.skipped?` (${j.skipped} already split)`:''} · ${j.current}`:`${s.split} of ${s.albums} CUE albums split into tracks${j.finished?' · last run '+new Date(j.finished).toLocaleString():''}`;
  $('split-state').textContent=progress+(j.errors.length?` · ${j.errors.length} errors: ${j.errors[j.errors.length-1]}`:'');
}
$('split').onclick=async()=>{$('split').disabled=true;try{await api('split/start',{});await refreshSplit();}catch(error){$('message').textContent=error.message;$('split').disabled=false;}};
$('split-force').onclick=async()=>{if(!confirm('Rewrite the tracks of every split album? Albums stay playable while each one is rewritten.'))return;$('split-force').disabled=true;try{await api('split/start',{force:true});await refreshSplit();}catch(error){$('message').textContent=error.message;}finally{$('split-force').disabled=false;}};
$('split-stop').onclick=async()=>{try{await api('split/stop',{});await refreshSplit();}catch(error){$('message').textContent=error.message;}};
$('key').onclick=async()=>{$('key').disabled=true;try{const result=await api('key',{});expires=result.expires;$('copy').textContent='Copy code';$('pair-code').textContent=result.code;$('key-result').hidden=false;countdown();}catch(error){$('message').textContent=error.message;}finally{$('key').disabled=false;}};
$('copy').onclick=async()=>{
  try {
    if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText($('pair-code').textContent);
    else {
      const field=document.createElement('textarea');field.value=$('pair-code').textContent;field.setAttribute('readonly','');field.className='copy-buffer';document.body.append(field);field.select();
      const copied=document.execCommand('copy');field.remove();if(!copied)throw new Error('Copy unavailable');
    }
    $('copy').textContent='Copied';
  } catch { $('message').textContent='Select and copy the pairing code manually.'; }
};
function countdown(){if(!expires)return;const seconds=Math.max(0,Math.ceil((expires-Date.now())/1000));$('expiry').textContent=seconds?`One use · expires in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'Expired — generate a new code';if(!seconds){expires=0;$('pair-code').textContent='Expired';}}
setInterval(()=>void refresh(true),5000);setInterval(countdown,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh(true);});

function el(tag,content,className){const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(className)node.className=className;return node;}
function clock(seconds){seconds=Math.max(0,Math.floor(seconds||0));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function formatAudio(f){return f?[f.codec?.toUpperCase(),f.bitDepth?`${f.bitDepth}-bit`:null,f.sampleRate?`${(f.sampleRate/1000).toLocaleString('en-US',{maximumFractionDigits:3})} kHz`:null,f.channels?`${f.channels} ch`:null].filter(Boolean).join(' · '):'Not reported';}
function deliveryLabel(mode){return {original:'Original',lossless:'Lossless repack',pcm:'PCM conversion',unknown:'Delivery not reported'}[mode]||mode;}
function audioDetail(row){return `${formatAudio(row.sourceFormat)}${row.delivery==='pcm'?' → '+formatAudio(row.outputFormat):''} · ${deliveryLabel(row.delivery)}`;}
function stateLabel(row){return row.stale?'Waiting for update':row.status==='stopped'?row.endReason||'Stopped':row.status.charAt(0).toUpperCase()+row.status.slice(1);}
async function refreshLive(){
  const result=await api('live');$('live-count').textContent=result.sessions.length?`${result.sessions.length} active session${result.sessions.length===1?'':'s'}`:'No active sessions';
  $('live-sessions').replaceChildren(...result.sessions.map(row=>{
    const card=el('article',undefined,'session');const top=el('div',undefined,'section-head');top.append(el('span',stateLabel(row),'state '+(row.status==='playing'&&!row.stale?'is-playing':'')),el('span',row.platform||'Platform not reported','detail'));
    card.append(top,el('p',row.listener || row.deviceName,'session-device'),el('h3',row.title),el('p',row.artist,'track-meta'));
    const audio=el('p',audioDetail(row),'detail session-audio');audio.title=audio.textContent+(row.route?' · '+row.route:'');card.append(audio);
    const bar=el('div',undefined,'session-progress'),fill=el('span');fill.style.width=`${row.duration?Math.min(100,row.position/row.duration*100):0}%`;bar.append(fill);
    const time=el('p',`${clock(row.position)} / ${clock(row.duration)}`,'session-time');time.setAttribute('aria-label','Playback time');card.append(bar,time);
    if(row.error){audio.textContent=row.error;audio.classList.add('error');audio.title=row.error;}return card;
  }));
  if(!result.sessions.length)$('live-sessions').append(el('p','No recent playback reports. Start a track from Sterio Server to see it here.','empty'));
  $('transfer-summary').textContent=`Active HTTP transfers · ${result.transfers.length}`;
  $('transfers').replaceChildren(...result.transfers.map(row=>el('p',`${row.title} · ${row.deviceName} · ${deliveryLabel(row.mode)}`,'detail')));
  if(!result.transfers.length)$('transfers').append(el('p','No audio file transfers at this moment. Playback can continue from the client buffer.','detail'));
  const signature=JSON.stringify(result.devices);
  if(signature!==deviceSignature){
    deviceSignature=signature;
    $('listener-devices').replaceChildren(...result.devices.map(device=>{
      const form=el('form',undefined,'listener-row'),info=el('div');info.append(el('strong',(device.listener || device.name)+(device.admin?' · Admin':'')+(device.revoked?' (revoked)':'')),el('small',device.listener ? device.name : 'Nickname not set','detail'));const input=el('input');input.value=device.listener;input.maxLength=120;input.placeholder='Nickname (optional)';input.setAttribute('aria-label','Nickname for '+device.name);const button=el('button','Save');button.type='submit';
      // Admin devices see Server administration in the app's Settings.
      const role=el('button',device.admin?'Remove admin':'Make admin');role.type='button';
      role.onclick=async()=>{role.disabled=true;try{await api('device/admin',{deviceId:device.id,admin:!device.admin});deviceSignature='';await refreshLive();}catch(error){$('message').textContent=error.message;}finally{role.disabled=false;}};
      // Removing deletes the device's key: it has to ask to connect again.
      const remove=el('button','Remove');remove.type='button';remove.className='danger';
      remove.onclick=async()=>{if(!confirm(`Remove ${device.listener || device.name}? It will have to ask to connect again.`))return;remove.disabled=true;try{await api('device/remove',{deviceId:device.id});deviceSignature='';await refreshLive();}catch(error){$('message').textContent=error.message;remove.disabled=false;}};
      form.append(info,input,button,role,remove);form.onsubmit=async event=>{event.preventDefault();button.disabled=true;try{await api('listener',{deviceId:device.id,label:input.value});deviceSignature='';await refreshLive();await refreshReport();}catch(error){$('message').textContent=error.message;}finally{button.disabled=false;}};return form;
    }));
  }
}
async function refreshReport(){
  const result=await api('latest');
  $('latest-playback').replaceChildren(...result.items.map(row=>{
    const item=el('article',undefined,'recent-item');
    const device=el('div',undefined,'recent-device');device.append(el('strong',row.listener || row.deviceName));
    const track=el('div',undefined,'recent-track');track.append(el('strong',row.title),el('small',row.artist));
    const date=el('time',new Date(row.started).toLocaleString());date.dateTime=new Date(row.started).toISOString();
    item.append(device,track,date);return item;
  }));
  if(!result.items.length)$('latest-playback').append(el('p','No playback yet. The latest track from each device will appear here.','empty'));
}


async function loadLibraryTools(){
  const result=await api('artists/tools');toolArtists=result.artists;
  const source=$('merge-source').value,target=$('merge-target').value;
  for(const id of ['merge-source','merge-target'])$(id).replaceChildren(new Option('Choose an artist…',''),...toolArtists.map(artist=>new Option(`${artist.name} (${artist.albums} albums)`,artist.id)));
  $('merge-source').value=source;$('merge-target').value=target;
  $('merge-suggestions').replaceChildren(...result.suggestions.map(group=>{
    const item=el('div',undefined,'suggestion'),title=el('p',group.map(artist=>artist.name).join(' / '),'detail'),button=el('button','Review merge');button.type='button';
    button.onclick=()=>{$('merge-source').value=group[1].id;$('merge-target').value=group[0].id;mergePreview();};item.append(title,button);return item;
  }));
  if(!result.suggestions.length)$('merge-suggestions').append(el('p','No obvious duplicate spellings found. You can still merge two artists below.','detail'));
  $('applied-merges').replaceChildren(...result.merges.map(row=>{const item=el('div',undefined,'suggestion'),button=el('button','Undo');button.type='button';button.onclick=()=>toolAction(button,async()=>{await api('artists/undo',{sourceId:row.source_id});await loadLibraryTools();await refresh();},'merge-message');item.append(el('p',`${row.source_name} → ${row.target_name}`,'detail'),button);return item;}));
  if(!result.merges.length)$('applied-merges').append(el('p','No merges applied.','detail'));
  await refreshArtworkTools();toolsLoaded=true;mergePreview();
}
function mergePreview(){const source=toolArtists.find(a=>a.id===$('merge-source').value),target=toolArtists.find(a=>a.id===$('merge-target').value);$('merge-preview').textContent=source&&target?`${source.albums} album${source.albums===1?'':'s'} from “${source.name}” will appear under “${target.name}”.`:'';}
$('merge-source').onchange=mergePreview;$('merge-target').onchange=mergePreview;
async function toolAction(button,action,message){button.disabled=true;$(message).textContent='';try{await action();}catch(error){$(message).textContent=error.message;}finally{button.disabled=(button.id==='fill-albums'||button.id==='fill-artists')&&artworkRunning;}}
$('merge-form').onsubmit=event=>{event.preventDefault();const button=event.submitter;void toolAction(button,async()=>{await api('artists/merge',{sourceId:$('merge-source').value,targetId:$('merge-target').value});await loadLibraryTools();await refresh();$('merge-message').textContent='Artists merged. Refresh the library in Sterio to see the change.';},'merge-message');};
let artworkBrowse=false,artworkPickerOpen=false,artworkActive=-1,artworkMatches=[];
const artworkText=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function artworkLabel(item){return `${item.artist?item.artist+' — ':''}${item.name}${item.year?' · '+item.year:''}`;}
function closeArtworkPicker(){artworkPickerOpen=false;artworkBrowse=false;artworkActive=-1;renderArtworkPicker();}
function selectArtworkItem(item){
  $('artwork-entity').value=item.id;$('artwork-filter').value=artworkLabel(item);$('artwork-query').value=item.query||'';
  $('artwork-results').replaceChildren();$('artwork-message').textContent='';closeArtworkPicker();$('artwork-filter').focus();
}
function renderArtworkPicker(){
  const input=$('artwork-filter'),selected=toolItems.find(item=>item.id===$('artwork-entity').value);
  $('artwork-search').disabled=!selected;$('reset-artwork').disabled=!selected;
  const terms=artworkText(input.value).trim().split(/\s+/).filter(Boolean);
  const matches=toolItems.filter(item=>(!artworkBrowse||item.kind==='album')&&(artworkBrowse||terms.every(term=>artworkText(`${item.name} ${item.artist||''} ${item.year||''}`).includes(term))))
    .sort((a,b)=>(a.artist||a.name).localeCompare(b.artist||b.name)||a.name.localeCompare(b.name));
  artworkMatches=artworkBrowse?matches:matches.slice(0,12);
  if(artworkActive>=artworkMatches.length)artworkActive=-1;
  const open=artworkPickerOpen&&(artworkBrowse||!!terms.length);
  input.setAttribute('aria-expanded',String(open));input.removeAttribute('aria-activedescendant');
  $('artwork-browse').textContent=artworkBrowse?'Hide album list':'Show all albums';$('artwork-browse').setAttribute('aria-expanded',String(artworkBrowse));
  const list=$('artwork-options');list.hidden=!open;
  list.replaceChildren(...(open?artworkMatches.map((item,index)=>{
    const option=el('div',undefined,'artwork-option');option.id='artwork-option-'+index;option.setAttribute('role','option');option.setAttribute('aria-selected',String(item.id===selected?.id));
    if(index===artworkActive){option.classList.add('active');input.setAttribute('aria-activedescendant',option.id);}
    option.append(el('strong',artworkLabel(item)),el('small',`${item.kind==='album'?'Album':'Artist'}${item.downloaded?' · downloaded artwork':''}`));
    option.onmousedown=event=>event.preventDefault();option.onclick=()=>selectArtworkItem(item);return option;
  }):[]));
  $('artwork-picker-status').textContent=open?(matches.length?`${artworkBrowse?matches.length+' albums':matches.length+(matches.length===1?' match':' matches')+(matches.length>12?' · showing 12, keep typing to narrow results':'')}`:'No matching albums or artists.'):(selected?`Selected ${selected.kind}: ${artworkLabel(selected)}`:'Type to search your library or browse all albums.');
}
$('artwork-filter').oninput=()=>{
  $('artwork-entity').value='';artworkBrowse=false;artworkPickerOpen=true;artworkActive=-1;
  $('artwork-results').replaceChildren();$('artwork-message').textContent='';renderArtworkPicker();
};
$('artwork-filter').onfocus=()=>{if(!$('artwork-entity').value&&$('artwork-filter').value.trim()){artworkPickerOpen=true;renderArtworkPicker();}};
$('artwork-filter').onkeydown=event=>{
  if(event.key==='Escape'){event.preventDefault();closeArtworkPicker();}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();artworkPickerOpen=true;artworkActive=Math.max(0,Math.min(artworkMatches.length-1,artworkActive+(event.key==='ArrowDown'?1:-1)));renderArtworkPicker();
    if(artworkActive>=0)$('artwork-option-'+artworkActive)?.scrollIntoView({block:'nearest'});
  }
  if(event.key==='Enter'){event.preventDefault();if(artworkPickerOpen&&artworkMatches.length)selectArtworkItem(artworkMatches[Math.max(0,artworkActive)]);}
};
$('artwork-browse').onclick=()=>{
  if(artworkBrowse){closeArtworkPicker();return;}
  artworkBrowse=true;artworkPickerOpen=true;artworkActive=-1;renderArtworkPicker();
};
document.addEventListener('click',event=>{if(artworkPickerOpen&&!artworkBrowse&&!$('artwork-picker').contains(event.target))closeArtworkPicker();});
async function refreshArtworkTools(){
  const result=await api('artwork/tools');toolsAt=Date.now();
  if(JSON.stringify(result.items)!==JSON.stringify(toolItems)){toolItems=result.items;if($('artwork-entity').value&&!toolItems.some(item=>item.id===$('artwork-entity').value)){ $('artwork-entity').value='';$('artwork-filter').value=''; }renderArtworkPicker();}
  const job=result.job;artworkRunning=job.running;$('fill-albums').disabled=job.running;$('fill-artists').disabled=job.running;$('stop-artwork').hidden=!job.running;
  $('artwork-job').textContent=job.total?`${job.running?(job.cancelled?'Stopping after current lookup…':'Working…'):job.cancelled?'Stopped':'Finished'} ${job.checked}/${job.total} checked · ${job.downloaded} downloaded · ${job.existing} already have artwork · ${job.notFound} unmatched · ${job.errors} errors${job.current?' · '+job.current:''}${job.lastError?' · Last error: '+job.lastError:''}`:'Choose a bulk action or search for an individual item below.';
  const names=new Map(toolItems.map(item=>[item.id,item.artist?item.artist+' — '+item.name:item.name]));
  $('artwork-credits').replaceChildren(...result.saved.map(row=>{const item=el('p',undefined,'detail'),link=el('a',row.provider);link.href=row.source_url;link.target='_blank';link.rel='noopener noreferrer';item.append(el('strong',names.get(row.entity_id)||'Library artwork'),document.createTextNode(' · '+row.credit+' · '),link);return item;}));
  if(!result.saved.length)$('artwork-credits').append(el('p','No online artwork downloaded yet.','detail'));
}
for(const [id,kind] of [['fill-albums','album'],['fill-artists','artist']])$(id).onclick=()=>toolAction($(id),async()=>{await api('artwork/start',{kind});await refreshArtworkTools();},'artwork-message');
$('stop-artwork').onclick=()=>toolAction($('stop-artwork'),async()=>{await api('artwork/stop',{});await refreshArtworkTools();},'artwork-message');

$('artwork-search-form').onsubmit=event=>{event.preventDefault();void toolAction($('artwork-search'),async()=>{
  if(!$('artwork-entity').value)throw new Error('Choose an album or artist from the results first.');
  $('artwork-message').textContent='Searching online…';$('artwork-results').replaceChildren();const result=await api('artwork/search',{entityId:$('artwork-entity').value,query:$('artwork-query').value});
  $('artwork-message').textContent=result.items.length?`${result.items.length} image${result.items.length===1?'':'s'} found. Choose a preview to use; it will replace the displayed artwork for this item.`:'No matching artwork found. Try a different search name.';
  $('artwork-results').replaceChildren(...result.items.map(candidate=>{const card=el('article',undefined,'artwork-choice'),image=el('img');image.src=candidate.preview;image.alt=candidate.title;image.loading='lazy';image.onerror=()=>{image.alt='Preview unavailable';};const link=el('a',candidate.provider);link.href=candidate.sourceUrl;link.target='_blank';link.rel='noopener noreferrer';const button=el('button','Use this image');button.type='button';button.onclick=()=>toolAction(button,async()=>{await api('artwork/apply',{token:candidate.token});await refreshArtworkTools();$('artwork-message').textContent='Artwork saved. Refresh the library in Sterio to see it.';},'artwork-message');card.append(image,el('strong',candidate.title),el('p',candidate.subtitle,'detail'),el('p',candidate.credit,'detail'),link,button);return card;}));
},'artwork-message');};
$('reset-artwork').onclick=()=>toolAction($('reset-artwork'),async()=>{await api('artwork/reset',{entityId:$('artwork-entity').value});await refreshArtworkTools();$('artwork-message').textContent='Original artwork restored.';},'artwork-message');
$('artwork-tools').addEventListener('toggle',()=>{if($('artwork-tools').open)void refreshArtworkTools().catch(error=>{$('artwork-message').textContent=error.message;});});
void refresh(true);

// Linked servers: libraries of other Sterio servers shown through this one.
let peerKeyExpires=0;
const ago=time=>{const minutes=Math.round((Date.now()-time)/60000);return minutes<1?'just now':minutes<60?`${minutes} min ago`:new Date(time).toLocaleString();};
async function refreshPeers(){
  const result=await api('peers');
  $('peer-connections').replaceChildren(...result.connections.map(peer=>{
    const item=el('div',undefined,'suggestion'),info=el('div');
    const counts=peer.tracks?`${number(peer.shown)} of ${number(peer.tracks)} tracks shown · ${number(peer.duplicates)} already here${peer.merged?` · ${number(peer.merged)} added to albums you have`:''}`:'No tracks indexed yet';
    const state=peer.pending?`Waiting for ${peer.name} to accept · code ${peer.pending}. Accept it on that server's page or in its Sterio app.`:peer.syncing?'Reading library index…':peer.error?peer.error:peer.synced?`Index updated ${ago(peer.synced)}`:'Waiting for the first index';
    info.append(el('strong',peer.name),el('p',`${peer.url} · ${counts}`,'detail'),el('p',state,'detail'+(peer.error&&!peer.syncing?' error':'')));
    const buttons=el('div',undefined,'tool-buttons'),sync=el('button',peer.syncing?'Refreshing…':'Refresh index'),remove=el('button',peer.pending?'Cancel':'Remove');
    sync.type=remove.type='button';sync.disabled=peer.syncing;sync.hidden=!!peer.pending||peer.declined;
    sync.onclick=()=>toolAction(sync,async()=>{await api('peers/sync',{id:peer.id});await refreshPeers();},'peer-message');
    remove.onclick=()=>{if(!confirm(`Remove ${peer.name}? Its tracks disappear from this server's library.`))return;void toolAction(remove,async()=>{await api('peers/remove',{id:peer.id});await refreshPeers();},'peer-message');};
    buttons.append(sync,remove);item.append(info,buttons);return item;
  }));
  if(!result.connections.length)$('peer-connections').append(el('p','No linked servers. Enter the other server\'s address below and press Connect.','detail'));
  $('peer-clients').replaceChildren(el('p',`This library shares ${number(result.sharedTracks)} tracks.`,'detail'),...result.clients.map(client=>{
    const item=el('div',undefined,'suggestion'),button=el('button','Stop sharing');button.type='button';
    button.onclick=()=>{if(!confirm(`Stop sharing this library with ${client.name}?`))return;void toolAction(button,async()=>{await api('peers/revoke',{deviceId:client.deviceId});await refreshPeers();},'peer-message');};
    item.append(el('p',`${client.name} · linked ${new Date(client.created).toLocaleDateString()}`,'detail'),button);return item;
  }));
}
$('peer-form').onsubmit=event=>{event.preventDefault();const button=event.submitter;void toolAction(button,async()=>{const result=await api('peers/connect',{url:$('peer-url').value,code:$('peer-code').value});$('peer-code').value='';$('peer-message').textContent=result.connections.some(peer=>peer.pending)?'Request sent. It connects as soon as the other server accepts it.':'Connected. The library index is being read; its albums appear in the apps when it finishes.';await refreshPeers();},'peer-message');};
$('peer-share').onclick=()=>toolAction($('peer-share'),async()=>{const result=await api('peers/share',{});peerKeyExpires=result.expires;$('peer-key-code').textContent=result.code;$('peer-key').hidden=false;peerCountdown();},'peer-message');
function peerCountdown(){if(!peerKeyExpires)return;const seconds=Math.max(0,Math.ceil((peerKeyExpires-Date.now())/1000));$('peer-key-expiry').textContent=seconds?`One use · expires in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'Expired — generate a new key';if(!seconds){peerKeyExpires=0;$('peer-key-code').textContent='Expired';}}
setInterval(peerCountdown,1000);

// Network streamers: the app picks one as output; the server drives its queue.
async function refreshRenderers(){
  const result=await api('renderers');
  $('renderer-list').replaceChildren(...result.items.map(renderer=>{
    const item=el('div',undefined,'suggestion'),info=el('div'),session=renderer.session;
    const kind=renderer.kind==='bluos'?'BluOS':'UPnP'+(renderer.gapless?' · gapless':'');
    const playing=session?.track?`${{playing:'Playing',paused:'Paused',buffering:'Loading',ended:'Finished',stopped:'Stopped',error:'Error'}[session.status]||session.status}: ${session.track.title} — ${session.track.artist}${session.duration?` · ${clock(session.position)} / ${clock(session.duration)}`:''}${session.controller?` · from ${session.controller}`:''}`:'Idle';
    info.append(el('strong',renderer.name),el('p',`${renderer.model||kind} · ${renderer.address} · ${kind}${renderer.dsd?' · DSD':''}`,'detail'),el('p',session?.error||playing,'detail'+(session?.error?' error':'')));
    if(!renderer.streamBase)info.append(el('p','Start playback from the app on the local network once, so the streamer knows this server\'s address.','detail'));
    const buttons=el('div',undefined,'tool-buttons'),stop=el('button','Stop'),remove=el('button','Remove');
    stop.type=remove.type='button';stop.disabled=!session||!['playing','paused','buffering'].includes(session.status);
    stop.onclick=()=>toolAction(stop,async()=>{await api('renderers/stop',{id:renderer.id});await refreshRenderers();},'renderer-message');
    remove.onclick=()=>{if(!confirm(`Remove ${renderer.name}?`))return;void toolAction(remove,async()=>{await api('renderers/remove',{id:renderer.id});await refreshRenderers();},'renderer-message');};
    buttons.append(stop,remove);item.append(info,buttons);return item;
  }));
  if(!result.items.length)$('renderer-list').append(el('p','No streamers yet. Enter a streamer\'s IP address below.','detail'));
}
$('renderer-form').onsubmit=event=>{event.preventDefault();void toolAction(event.submitter,async()=>{await api('renderers/add',{address:$('renderer-address').value});$('renderer-address').value='';$('renderer-message').textContent='Streamer added.';await refreshRenderers();},'renderer-message');};
$('renderer-discover').onclick=()=>toolAction($('renderer-discover'),async()=>{const result=await api('renderers/discover',{});$('renderer-message').textContent=result.items.length?`Found UPnP renderers at ${result.items.map(item=>item.address).join(', ')}. Add one by its IP address.`:'No new UPnP renderers answered (Docker networks often block this search; enter the IP address instead). BluOS players are added by IP address.';},'renderer-message');

// Sections as tabs; the address keeps the open tab (#devices), so reload and back work.
const tabs=['home','activity','devices','library','servers'];
function showTab(){
  const current=tabs.includes(location.hash.slice(1))?location.hash.slice(1):'home';
  for(const name of tabs){const selected=name===current;$('panel-'+name).hidden=!selected;$('tab-'+name).setAttribute('aria-selected',String(selected));$('tab-'+name).tabIndex=selected?0:-1;}
}
document.querySelector('.tabs').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
  const index=tabs.indexOf(location.hash.slice(1)||'home'),next=tabs[(Math.max(0,index)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];
  location.hash=next;$('tab-'+next).focus();
});
window.addEventListener('hashchange',showTab);showTab();

// Sterio Server for Mac: choose the music folder and connect a phone.
let macExpires=0,macRestarting=false;
async function refreshMac(){
  let m;
  try{m=await api('mac');}catch(error){if(macRestarting)return;throw error;}
  if(macRestarting){macRestarting=false;$('mac-choose').disabled=false;}
  $('mac-setup').hidden=!m.enabled;if(!m.enabled)return;
  $('mac-folder').textContent=m.musicDir?m.musicDir:'No folder chosen yet.';
  $('mac-choose').textContent=m.musicDir?'Choose another folder…':'Choose music folder…';
  $('mac-address').textContent=m.addresses.length?m.addresses.join('  ·  '):'Connect this Mac to Wi-Fi or Ethernet first.';
  $('mac-health').textContent=m.addresses.length?m.addresses[0]+'/healthz':'http://<this Mac>:7766/healthz';
  const f=m.firewall,blocked=!!f&&f.enabled&&(f.blockAll||!f.allowed);
  $('mac-firewall').hidden=!blocked;
  if(blocked){
    $('mac-firewall-text').textContent=f.blockAll?'The macOS Firewall blocks all incoming connections, so iPhones cannot reach this server. In System Settings → Network → Firewall → Options, turn off “Block all incoming connections”.':'The macOS Firewall is on and has not allowed Sterio Server, so iPhones cannot reach it. This Mac will ask for its password once.';
    $('mac-firewall-allow').hidden=f.blockAll;
  }
}
$('mac-choose').onclick=async()=>{
  $('mac-choose').disabled=true;$('message').textContent='A folder window opened on this Mac. Pick your music folder there.';
  try{
    const result=await api('mac/folder',{});
    if(result.cancelled){$('message').textContent='';$('mac-choose').disabled=false;return;}
    macRestarting=true;$('mac-folder').textContent=result.musicDir;
    $('message').textContent='Starting again with your music. The first scan can take a while for a large collection.';
  }catch(error){$('message').textContent=error.message;$('mac-choose').disabled=false;}
};
$('mac-key').onclick=async()=>{$('mac-key').disabled=true;try{const result=await api('key',{});macExpires=result.expires;$('mac-code').textContent=result.code;$('mac-key-result').hidden=false;macCountdown();}catch(error){$('message').textContent=error.message;}finally{$('mac-key').disabled=false;}};
function macCountdown(){if(!macExpires)return;const seconds=Math.max(0,Math.ceil((macExpires-Date.now())/1000));$('mac-expiry').textContent=seconds?`Expires in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'Expired — show a new code';if(!seconds){macExpires=0;$('mac-code').textContent='Expired';}}
setInterval(macCountdown,1000);
$('mac-firewall-allow').onclick=async()=>{$('mac-firewall-allow').disabled=true;$('message').textContent='Enter this Mac’s password in the window that opened.';try{await api('mac/firewall',{});$('message').textContent='iPhones can connect now.';await refreshMac();}catch(error){$('message').textContent=error.message==='Cancelled.'?'':error.message;}finally{$('mac-firewall-allow').disabled=false;}};

// Apps and servers that asked to connect with this server's address.
let requestSignature='';
async function refreshRequests(){
  const result=await api('requests'),signature=JSON.stringify(result.items);
  $('requests').hidden=!result.items.length;
  if(signature===requestSignature)return;
  requestSignature=signature;
  $('request-list').replaceChildren(...result.items.map(request=>{
    const item=el('div',undefined,'suggestion'),info=el('div'),buttons=el('div',undefined,'tool-buttons'),accept=el('button','Accept','primary'),decline=el('button','Decline');
    accept.type=decline.type='button';
    info.append(el('strong',`${request.kind==='server'?'Server':'Device'} · ${request.name}`),el('p',`Code ${request.code} · ${request.address||'unknown address'} · ${ago(request.created)}`,'detail'));
    const decide=(button,value)=>toolAction(button,async()=>{await api('requests/decide',{id:request.id,accept:value});requestSignature='';$('request-message').textContent=value?(request.kind==='server'?`${request.name} can now show this library.`:`${request.name} is connected.`):'Request declined.';await refreshRequests();await refresh(true);},'request-message');
    accept.onclick=()=>decide(accept,true);decline.onclick=()=>decide(decline,false);
    buttons.append(accept,decline);item.append(info,buttons);return item;
  }));
}
