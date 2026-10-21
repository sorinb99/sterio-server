import { mkdir, stat, writeFile, rename, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { db, hash } from './db.mjs';
import { HttpError } from './auth.mjs';
import { getCatalog, albumViews, groupViews, artworkPath, processFile } from './library.mjs';
import { linkedHasArtwork } from './peers.mjs';
import { canonicalArtist, artistNameKey, storedArtwork, reloadLibraryState } from './library-state.mjs';

const root=path.join(config.data,'artwork'), previews=path.join(root,'previews');
await mkdir(previews,{recursive:true});
const userAgent='SterioServer/0.1.10 (https://github.com/sorinb99/sterio-server)';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain=value=>String(value || '').replace(/<[^>]*>/g,'').replace(/[\x00-\x1f]/g,' ').slice(0,1000);
const titleKey=value=>artistNameKey(value).replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/g,' ').trim();
function cleanAlbumTitle(value){let title=String(value).trim();for(let i=0;i<5;i++){const next=title.replace(/\s+(?:CD|Disc)\s*\d+$/i,'').replace(/\s*[\[(]([^\])]+)[\])]$/g,(match,note)=>/edition|deluxe|remaster|expanded|japan|shm|records|capitol|vertigo|warner|provogue|sanctuary|roadrunner|t-boy|cd\s*\d|disc\s*\d|\d{3,}/i.test(note)?'':match).trim();if(!next||next===title)break;title=next;}return title;}
function imageURL(value){try{const url=new URL(value);if(url.protocol==='http:')url.protocol='https:';return allowed(url)?url.href:null;}catch{return null;}}
const lucene=value=>'"'+String(value).replace(/[+\-!(){}\[\]^"~*?:\\/&|]/g,' ')+'"';
// Each provider has its own pace, so a slow one never holds up the others:
// MusicBrainz asks for one request a second, iTunes for about twenty a
// minute, Deezer allows fifty every five seconds; image hosts have no limit.
const hosts=[
  {match:'musicbrainz.org',concurrency:1,interval:1100},
  {match:'itunes.apple.com',concurrency:1,interval:3100},
  {match:'api.deezer.com',concurrency:4,interval:120},
  {match:'wikidata.org',concurrency:2,interval:200},
  {match:'wikimedia.org',concurrency:2,interval:200},
  {match:'',concurrency:6,interval:0},
].map(host=>({...host,active:0,last:0,waiting:[]}));
const hostOf=url=>hosts.find(host=>!host.match||url.hostname===host.match||url.hostname.endsWith('.'+host.match));
function pump(host){
  while(host.active<host.concurrency&&host.waiting.length){
    const wait=host.last+host.interval-Date.now();
    if(wait>0){if(!host.timer)host.timer=setTimeout(()=>{host.timer=null;pump(host);},wait);return;}
    host.last=Date.now();host.active++;const next=host.waiting.shift();
    next.run().then(next.resolve,next.reject).finally(()=>{host.active--;pump(host);});
  }
}
function paced(url,run){const host=hostOf(url);if(host.waiting.length>=200)return Promise.reject(new HttpError(429,'Artwork provider queue is full. Try again later.'));return new Promise((resolve,reject)=>{host.waiting.push({run,resolve,reject});pump(host);});}
function allowed(url){return url.protocol==='https:' && (!url.port||url.port==='443') && !url.username && !url.password && ['musicbrainz.org','coverartarchive.org','archive.org','wikidata.org','wikimedia.org','wikipedia.org','deezer.com','dzcdn.net','itunes.apple.com','mzstatic.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host));}
async function remote(url, max=3*1024*1024, redirects=0,timeout=20000){
  url=new URL(url);if(!allowed(url)||redirects>5)throw new HttpError(502,'Unsupported artwork source');
  const result=await paced(url,async()=>{
    const response=await fetch(url,{headers:{'User-Agent':userAgent,Accept:'application/json,image/*'},redirect:'manual',signal:AbortSignal.timeout(timeout)});
    if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new HttpError(502,'Artwork redirect missing');return {redirect:new URL(location,url).href};}
    if(!response.ok){await response.body?.cancel();throw new HttpError(response.status===404?404:502,response.status===404?'Artwork not found':`Artwork provider unavailable (${response.status})`);}
    if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new HttpError(502,'Artwork response is too large');}
    let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new HttpError(502,'Artwork response is too large');chunks.push(chunk);}
    return {bytes:Buffer.concat(chunks),type:response.headers.get('content-type')||''};
  });
  if(result.redirect)return remote(result.redirect,max,redirects+1,timeout);return result;
}
async function json(url,timeout=20000){
  const key=hash(url),cached=db.prepare('SELECT value FROM metadata_cache WHERE key=? AND expires>?').get(key,Date.now());if(cached)return JSON.parse(cached.value);
  let result;
  for(let attempt=0;;attempt++){
    try{const response=await remote(url,3*1024*1024,0,timeout);try{result=JSON.parse(response.bytes);}catch{throw new HttpError(502,'Invalid provider response');}}
    catch(error){if(attempt<2&&/\((503|429)\)/.test(error.message)){await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));continue;}throw error;}
    // Deezer reports its quota in the body: wait and ask again.
    if(result?.error?.code===4&&attempt<2){await new Promise(resolve=>setTimeout(resolve,5000));continue;}
    if(result?.error&&url.includes('deezer.com'))throw new HttpError(502,'Deezer: '+plain(result.error.message||'unavailable'));
    break;
  }
  db.prepare('DELETE FROM metadata_cache WHERE expires<?').run(Date.now());
  db.prepare('INSERT OR REPLACE INTO metadata_cache VALUES (?,?,?)').run(key,JSON.stringify(result),Date.now()+48*3600000);return result;
}
export function artistTools(){
  const artists=groupViews('artists').map(item=>({id:item.ref.itemId,name:item.title,albums:0}));const counts=new Map();for(const album of albumViews())counts.set(album.artistId,(counts.get(album.artistId)||0)+1);for(const artist of artists)artist.albums=counts.get(artist.id)||0;
  artists.sort((a,b)=>a.name.localeCompare(b.name));const groups=new Map();for(const item of artists){const key=artistNameKey(item.name);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  return {artists,suggestions:[...groups.values()].filter(items=>items.length>1).map(items=>items.sort((a,b)=>b.albums-a.albums||a.name.localeCompare(b.name))),merges:db.prepare('SELECT * FROM artist_aliases ORDER BY created DESC').all()};
}
export function mergeArtists(input){
  const artists=artistTools().artists, source=artists.find(item=>item.id===input.sourceId),target=artists.find(item=>item.id===input.targetId);
  if(!source||!target||source.id===target.id)throw new HttpError(400,'Choose two different artists');
  if(canonicalArtist(target.id,target.name).id===source.id)throw new HttpError(400,'This merge would create a loop');
  db.exec('BEGIN IMMEDIATE');try{
    db.prepare('INSERT OR REPLACE INTO artist_aliases VALUES (?,?,?,?,?)').run(source.id,target.id,source.name,target.name,Date.now());
    db.prepare('INSERT OR IGNORE INTO favorites(device_id,item_id) SELECT device_id,? FROM favorites WHERE item_id=?').run(target.id,source.id);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  reloadLibraryState();return {ok:true};
}
export function undoMerge(input){if(typeof input.sourceId!=='string')throw new HttpError(400,'Invalid artist');db.prepare('DELETE FROM artist_aliases WHERE source_id=?').run(input.sourceId);reloadLibraryState();return {ok:true};}
// Linked albums and artists are included: artwork chosen here wins over their server's.
function entities(){return [...albumViews().map(item=>({id:item.ref.itemId,kind:'album',name:item.title,artist:item.artist,year:item.year})),...groupViews('artists').map(item=>({id:item.ref.itemId,kind:'artist',name:item.title}))];}
function entity(id){const item=entities().find(value=>value.id===id);if(!item)throw new HttpError(404,'Library item not found');return item;}
export function artworkTools(){return {items:entities().sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name)).map(item=>({...item,downloaded:!!storedArtwork(item.id)})),job:{...job},saved:db.prepare('SELECT entity_id,provider,source_url,credit,created FROM library_artwork ORDER BY created DESC LIMIT 20').all()};}
function saveCandidates(item,results){
  const expired=db.prepare('SELECT token FROM artwork_candidates WHERE created<?').all(Date.now()-86400000);
  db.prepare('DELETE FROM artwork_candidates WHERE created<?').run(Date.now()-86400000);
  for(const row of expired)void unlink(path.join(previews,row.token+'.jpg')).catch(()=>{});
  return results.slice(0,16).map(result=>{const token=randomBytes(24).toString('hex');db.prepare('INSERT INTO artwork_candidates VALUES (?,?,?,?)').run(token,item.id,JSON.stringify(result),Date.now());return {token,title:result.title,subtitle:result.subtitle,provider:result.provider,sourceUrl:result.sourceUrl,credit:result.credit,exact:result.exact,preview:'/api/artwork/preview?token='+token};});
}
// Artist names compared without a leading "The" (Blackbyrds, The Blackbyrds).
const artistKey=value=>artistNameKey(value).replace(/^the /,'');
const sameAlbum=(title,artist,item)=>titleKey(cleanAlbumTitle(title))===titleKey(cleanAlbumTitle(item.name))&&artistKey(artist)===artistKey(item.artist);
// Albums before compilations, EPs and singles of the same name (Paranoid the
// album, not the single).
const releaseRank={album:0,compile:1,ep:2,single:3};
async function deezerAlbums(item,query,automatic){
  const q=query||`artist:"${item.artist.replace(/"/g,' ')}" album:"${cleanAlbumTitle(item.name).replace(/"/g,' ')}"`;
  const data=await json('https://api.deezer.com/search/album?limit=25&q='+encodeURIComponent(q));
  let albums=data.data||[];
  // The strict form misses differently spelled titles, and can rank the single
  // above the album: a plain search finds them.
  if(!query&&!albums.some(album=>album.record_type==='album'&&sameAlbum(album.title,album.artist?.name||'',item))){
    const more=await json('https://api.deezer.com/search/album?limit=25&q='+encodeURIComponent(item.artist+' '+cleanAlbumTitle(item.name)));
    const ids=new Set(albums.map(album=>album.id));albums=albums.concat((more.data||[]).filter(album=>!ids.has(album.id)));
  }
  return albums.filter(album=>album.cover_xl&&!/\/images\/cover\/\//.test(album.cover_xl)).map(album=>({title:album.title,subtitle:[album.artist?.name,album.record_type].filter(Boolean).join(' · '),provider:'Deezer',imageUrl:imageURL(album.cover_xl),sourceUrl:imageURL(album.link)||'https://www.deezer.com/album/'+album.id,credit:'Cover · Deezer',exact:sameAlbum(album.title,album.artist?.name||'',item),rank:releaseRank[album.record_type]??2})).filter(result=>result.imageUrl).sort((a,b)=>b.exact-a.exact||a.rank-b.rank).slice(0,automatic?4:12);
}
async function itunesAlbums(item,query,automatic){
  const data=await json('https://itunes.apple.com/search?media=music&entity=album&limit=25&term='+encodeURIComponent(query||item.artist+' '+cleanAlbumTitle(item.name)));
  return (data.results||[]).filter(album=>album.artworkUrl100).map(album=>{const single=/ - (Single|EP)$/.test(album.collectionName);const title=album.collectionName.replace(/ - (Single|EP)$/,'');return {title,subtitle:[album.artistName,album.releaseDate?.slice(0,4),single?album.collectionName.match(/(Single|EP)$/)[1]:''].filter(Boolean).join(' · '),provider:'Apple Music',imageUrl:imageURL(album.artworkUrl100.replace(/\/\d+x\d+bb\./,'/1000x1000bb.')),sourceUrl:imageURL(album.collectionViewUrl)||'https://music.apple.com',credit:'Cover · Apple Music',exact:sameAlbum(title,album.artistName,item),rank:single?3:0};}).filter(result=>result.imageUrl).sort((a,b)=>b.exact-a.exact||a.rank-b.rank).slice(0,automatic?4:12);
}
// Deezer first (large covers, generous limits), Apple Music next, then
// MusicBrainz and the Cover Art Archive. Automatic runs stop at the first
// exact match; a search from the dashboard shows what every provider found.
async function albumCandidates(item,query,automatic=false){
  const results=[];let lastError;
  for(const provider of [deezerAlbums,itunesAlbums,musicbrainzAlbums]){
    try{const found=await provider(item,query,automatic);results.push(...found);if(automatic&&found.some(result=>result.exact))break;}
    catch(error){lastError=error;}
  }
  if(!results.length&&lastError)throw lastError;
  const seen=new Set();return results.filter(result=>!seen.has(result.imageUrl)&&seen.add(result.imageUrl)).map(({rank,...result})=>result);
}
async function musicbrainzAlbums(item,query,automatic=false){
  const title=query || cleanAlbumTitle(item.name);
  const search=`release:${lucene(title)} AND artist:${lucene(item.artist)}`;
  const data=await json('https://musicbrainz.org/ws/2/release/?fmt=json&limit='+(automatic?8:40)+'&query='+encodeURIComponent(search));
  const candidates=[];let providerError;const deadline=Date.now()+45000;
  const seen=new Set();
  for(const release of (data.releases || []).filter(release=>release['cover-art-archive']?.front!==false).slice(0,automatic?6:24)){
    if(!automatic&&Date.now()>=deadline)break;
    if(!uuid.test(release.id))continue;
    const artists=(release['artist-credit']||[]).map(a=>a.artist?.name||a.name||'').join(' ');
    const exact=titleKey(cleanAlbumTitle(release.title))===titleKey(cleanAlbumTitle(item.name)) && artistNameKey(artists)===artistNameKey(item.artist);
    try{
      const cover=await json('https://coverartarchive.org/release/'+release.id,automatic?20000:Math.max(1000,Math.min(8000,deadline-Date.now())));
      for(const image of (cover.images||[]).filter(image=>image.front && image.approved!==false)){
      const imageUrl=imageURL(image?.thumbnails?.['500']||image?.thumbnails?.small||image?.image);
      if(!imageUrl||seen.has(imageUrl))continue;seen.add(imageUrl);
      candidates.push({title:release.title,subtitle:[artists,release.date,release.country].filter(Boolean).join(' · '),provider:'Cover Art Archive',imageUrl,sourceUrl:'https://musicbrainz.org/release/'+release.id,credit:'Front cover · Cover Art Archive / MusicBrainz',exact});
      if(candidates.length>=(automatic?4:16))break;
      }
      if(candidates.length>=(automatic?4:16) || automatic&&exact&&!query)break;
    }catch(error){if(error.status!==404){if(automatic)throw error;providerError=error;}}
  }
  if(!candidates.length&&providerError)throw providerError;
  return candidates;
}
async function linkedArtistCandidates(item,query){
  const data=await json('https://musicbrainz.org/ws/2/artist/?fmt=json&limit=5&query='+encodeURIComponent('artist:'+lucene(query||item.name)));
  const results=[];
  const exactNames=(data.artists||[]).filter(artist=>artistNameKey(artist.name)===artistNameKey(item.name)).length;
  for(const artist of (data.artists||[]).slice(0,4)){
    if(!uuid.test(artist.id))continue;
    const nameMatches=artistNameKey(artist.name)===artistNameKey(item.name);
    const exact=nameMatches && exactNames===1;
    if(!query && !nameMatches)continue;
    const details=await json('https://musicbrainz.org/ws/2/artist/'+artist.id+'?fmt=json&inc=url-rels');
    const link=details.relations?.find(rel=>rel.type==='wikidata')?.url?.resource;
    const qid=link?.match(/\/Q(\d+)$/)?.[1];if(!qid)continue;
    const wikidata=await json('https://www.wikidata.org/wiki/Special:EntityData/Q'+qid+'.json');
    const filename=wikidata.entities?.['Q'+qid]?.claims?.P18?.find(claim=>claim.rank!=='deprecated')?.mainsnak?.datavalue?.value;
    if(typeof filename!=='string')continue;
    const params=new URLSearchParams({action:'query',format:'json',titles:'File:'+filename,prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'800'});
    const commons=await json('https://commons.wikimedia.org/w/api.php?'+params);
    const image=Object.values(commons.query?.pages||{}).find(page=>page.imageinfo)?.imageinfo?.[0];
    const imageUrl=image?.thumburl||image?.url;if(!imageUrl||!allowed(new URL(imageUrl)))continue;
    const meta=image.extmetadata||{};
    const credit=[plain(meta.Artist?.value),plain(meta.LicenseShortName?.value)].filter(Boolean).join(' · ');
    results.push({title:artist.name,subtitle:artist.disambiguation||artist.type||'Artist',provider:'Wikimedia Commons',imageUrl,sourceUrl:imageURL(image.descriptionurl)||'https://commons.wikimedia.org/wiki/File:'+encodeURIComponent(filename),credit:credit||'Wikimedia Commons',exact});
    if(results.length>=3 || exact&&!query)break;
  }
  return results;
}
function commonsCandidate(page,title){
  const image=page.imageinfo?.[0],url=imageURL(image?.thumburl||image?.url);if(!url||!/^image\/(jpeg|png|webp|gif)$/.test(image.mime||''))return null;
  const meta=image.extmetadata||{};
  return {title,subtitle:plain(page.title?.replace(/^File:/,'')),provider:'Wikimedia Commons',imageUrl:url,sourceUrl:imageURL(image.descriptionurl)||'https://commons.wikimedia.org/wiki/'+encodeURIComponent(page.title),credit:[plain(meta.Artist?.value),plain(meta.LicenseShortName?.value)].filter(Boolean).join(' · ')||'Wikimedia Commons',exact:false};
}
// Deezer's artist photos. A name shared by several artists is settled by the
// albums: the one whose catalogue has an album of this library wins.
async function deezerArtists(item,query,automatic){
  const data=await json('https://api.deezer.com/search/artist?limit=10&q='+encodeURIComponent(query||item.name));
  const artists=(data.data||[]).filter(artist=>artist.picture_xl&&!/\/images\/artist\/\//.test(artist.picture_xl));
  const named=artists.filter(artist=>artistKey(artist.name)===artistKey(item.name));
  let chosen=named.length===1?named[0]:null;
  if(named.length>1){
    named.sort((a,b)=>(b.nb_fan||0)-(a.nb_fan||0));
    const titles=new Set(albumViews().filter(album=>artistKey(album.artist)===artistKey(item.name)).map(album=>titleKey(cleanAlbumTitle(album.title))));
    for(const artist of named.slice(0,3)){
      const albums=await json('https://api.deezer.com/artist/'+artist.id+'/albums?limit=100').catch(()=>({}));
      if((albums.data||[]).some(album=>titles.has(titleKey(cleanAlbumTitle(album.title))))){chosen=artist;break;}
    }
    // No album to tell them apart: the far better known one.
    if(!chosen&&(named[0].nb_fan||0)>=5*Math.max(1,named[1].nb_fan||0))chosen=named[0];
  }
  return artists.map(artist=>({title:artist.name,subtitle:[artist.nb_fan?artist.nb_fan.toLocaleString('en')+' fans':'','Deezer'].filter(Boolean).join(' · '),provider:'Deezer',imageUrl:imageURL(artist.picture_xl),sourceUrl:imageURL(artist.link)||'https://www.deezer.com/artist/'+artist.id,credit:'Artist photo · Deezer',exact:artist===chosen})).filter(result=>result.imageUrl).sort((a,b)=>b.exact-a.exact).slice(0,automatic?3:8);
}
async function artistCandidates(item,query,automatic){
  let deezer=[],deezerError;
  try{deezer=await deezerArtists(item,query,automatic);}catch(error){deezerError=error;}
  if(automatic){if(deezer.some(result=>result.exact))return deezer;try{return [...deezer,...await linkedArtistCandidates(item,query)];}catch(error){if(deezer.length)return deezer;throw deezerError||error;}}
  let linked=[],linkedError;
  try{linked=await linkedArtistCandidates(item,query);}catch(error){linkedError=error;}
  linked=[...deezer,...linked];if(!linked.length&&deezerError&&linkedError)linkedError=deezerError;
  const name=(query||item.name).replace(/["\\]/g,' ').trim();
  const params=new URLSearchParams({action:'query',format:'json',generator:'search',gsrsearch:'"'+name+'" filetype:bitmap',gsrnamespace:'6',gsrlimit:'24',prop:'imageinfo',iiprop:'url|extmetadata|mime',iiurlwidth:'800'});
  let commons;
  try{commons=await json('https://commons.wikimedia.org/w/api.php?'+params);}catch(error){if(!linked.length)throw linkedError||error;return linked;}
  if(commons.error){if(!linked.length)throw new HttpError(502,'Artist image search is unavailable. Try again later.');return linked;}
  const seen=new Set(linked.map(result=>result.imageUrl));
  const pages=Object.values(commons.query?.pages||{}).sort((a,b)=>(a.index||0)-(b.index||0));
  for(const page of pages){const result=commonsCandidate(page,query||item.name);if(result&&!seen.has(result.imageUrl)){seen.add(result.imageUrl);linked.push(result);}if(linked.length>=16)break;}
  return linked;
}
export async function searchArtwork(input,automatic=false,known){const item=known||entity(input.entityId);const query=String(input.query||'').trim().slice(0,200);return {items:saveCandidates(item,item.kind==='album'?await albumCandidates(item,query,automatic):await artistCandidates(item,query,automatic))};}
function candidate(token){if(typeof token!=='string'||!/^[a-f0-9]{48}$/.test(token))throw new HttpError(400,'Invalid artwork choice');const row=db.prepare('SELECT * FROM artwork_candidates WHERE token=? AND created>?').get(token,Date.now()-86400000);if(!row)throw new HttpError(404,'Artwork choice expired. Search again.');return {...row,value:JSON.parse(row.value)};}
const previewJobs=new Map();
async function renderPreview(token){
  const row=candidate(token),file=path.join(previews,token+'.jpg');try{await stat(file);return file;}catch{}
  const raw=path.join(previews,token+'.download');const temp=path.join(previews,token+'.tmp.jpg');
  try{const image=await remote(row.value.imageUrl,12*1024*1024);if(!['image/jpeg','image/png','image/webp','image/gif'].includes(image.type.split(';')[0]))throw new HttpError(502,'Provider did not return an image');await writeFile(raw,image.bytes,{mode:0o600});await processFile('ffmpeg',['-v','error','-nostdin','-y','-protocol_whitelist','file','-i',raw,'-vf','scale=1000:1000:force_original_aspect_ratio=decrease','-frames:v','1','-f','image2',temp],15000);await rename(temp,file);return file;}finally{await unlink(raw).catch(()=>{});await unlink(temp).catch(()=>{});}
}
export async function previewArtwork(token){if(previewJobs.has(token))return previewJobs.get(token);if(previewJobs.size>=16)throw new HttpError(429,'Too many artwork previews');const work=renderPreview(token).finally(()=>previewJobs.delete(token));previewJobs.set(token,work);return work;}
export async function applyArtwork(input,known){
  const row=candidate(input.token);if(!known)entity(row.entity_id);
  const file=await previewArtwork(input.token),version='online-'+randomBytes(8).toString('hex'),filename=row.entity_id+'-'+version+'.jpg';
  await copyFile(file,path.join(root,filename));
  db.prepare('INSERT OR REPLACE INTO library_artwork VALUES (?,?,?,?,?,?,?)').run(row.entity_id,filename,version,row.value.provider,row.value.sourceUrl,row.value.credit,Date.now());reloadLibraryState();return {ok:true};
}
export function resetArtwork(input){entity(input.entityId);db.prepare('DELETE FROM library_artwork WHERE entity_id=?').run(input.entityId);reloadLibraryState();return {ok:true};}
const job={running:false,cancelled:false,total:0,checked:0,downloaded:0,existing:0,notFound:0,errors:0,current:'',lastError:'',finished:null};
export function startArtworkJob(input){
  if(job.running)throw new HttpError(409,'An artwork job is already running');
  const kind=['album','artist'].includes(input.kind)?input.kind:'all';const items=entities().filter(item=>kind==='all'||item.kind===kind);
  Object.assign(job,{running:true,cancelled:false,total:items.length,checked:0,downloaded:0,existing:0,notFound:0,errors:0,current:'',lastError:'',finished:null});
  // Six at a time: each provider keeps its own pace (see hosts), so lookups
  // waiting on MusicBrainz never hold up the ones Deezer answers at once.
  let next=0;
  const worker=async()=>{
    while(next<items.length&&!job.cancelled){const item=items[next++];job.current=item.kind+': '+item.name;
      try{
        const saved=storedArtwork(item.id);let exists=false;if(saved)try{await stat(saved.path);exists=true;}catch{}
        // Artwork a linked server already has counts as existing: it is shown through it.
        if(exists || await artworkPath(item.id,{portraitOnly:item.kind==='artist',localOnly:true}) || await linkedHasArtwork(item)){job.existing++;continue;}
        const candidates=await searchArtwork({entityId:item.id},true,item);const selected=candidates.items.find(candidate=>candidate.exact);
        if(!selected){job.notFound++;continue;}
        if(job.cancelled)break;
        await applyArtwork({token:selected.token},item);job.downloaded++;
      }catch(error){job.errors++;job.lastError=plain(error.message);}finally{job.checked++;}
    }
  };
  void (async()=>{try{
    await Promise.all(Array.from({length:6},worker));
  }finally{job.running=false;job.current='';job.finished=new Date().toISOString();}})().catch(error=>{job.lastError=plain(error.message);});return {ok:true};
}
export function cancelArtworkJob(){job.cancelled=true;return {ok:true};}
