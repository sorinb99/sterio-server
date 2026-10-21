import { readdir, stat, realpath, mkdir, unlink, readFile } from 'node:fs/promises';
import { marks, profileDevices } from './profiles.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.mjs';
import { db, hash, getSetting } from './db.mjs';
import { readCue } from './cue.mjs';
import { applyArtistAlias, canonicalArtist, storedArtwork, artworkTag, stateRevision } from './library-state.mjs';
const extensions = new Set(['.mp3','.flac','.m4a','.aac','.alac','.wav','.aif','.aiff','.ogg','.opus','.dsf','.dff','.dsdiff']);
export const cacheDir = path.join(config.data, 'cache');
// Server-split CUE albums: a hidden folder of ordinary FLAC tracks inside the
// album, so file browsers and other players (SMB, Finder) don't list them twice.
export const SPLIT_FOLDER = '.sterio-tracks', LEGACY_SPLIT_FOLDER = 'Tracks', SPLIT_MARKER = '.sterio-split.json';
await mkdir(cacheDir, { recursive: true });
let version = 0, catalogVersion = -1, catalog = [];
export const scanStatus = { running: false, scanned: 0, indexed: 0, errors: 0, lastFinished: null };
let pendingScan = false;
export function processFile(command, args, timeout = 30000, maxOutput = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'] });
    const output = []; let bytes = 0, errorText = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutput) child.kill('SIGKILL'); else output.push(chunk); });
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-1000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0 && bytes <= maxOutput) resolve(Buffer.concat(output)); else reject(new Error(`${command} failed (${code}): ${errorText}`)); });
  });
}
export async function musicPath(relative) {
  const root = await realpath(config.music);
  const file = await realpath(path.join(root, relative));
  if (!file.startsWith(root + path.sep)) throw new Error('File is outside the music folder');
  return file;
}
// Normalize persisted metadata too: unchanged files are not reprobed on scans.
function decodeMetadata(value) {
  const item=JSON.parse(value);
  item.format={...item.format,codec:String(item.format?.codec||'unknown').toLowerCase(),container:String(item.format?.container||'').toLowerCase()};
  return item;
}
const ref = id => ({ provider: 'sterio', itemId: id });
function readTags(tags = {}) { return Object.fromEntries(Object.entries(tags).map(([key,value]) => [key.toLowerCase(), String(value)])); }
async function metadata(relative) {
  const absolute = await musicPath(relative);
  const probe = JSON.parse((await processFile('ffprobe', ['-v','error','-protocol_whitelist','file','-probesize','8000000','-analyzeduration','10000000','-show_format','-show_streams','-of','json', absolute])).toString());
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  if (!audio) throw new Error('No audio stream');
  const tags = { ...readTags(probe.format?.tags), ...readTags(audio.tags) };
  const artist = (tags.artist || tags.album_artist || 'Unknown artist').slice(0,512);
  const albumArtist = (tags.album_artist || tags.albumartist || artist).slice(0,512);
  let folder = path.dirname(relative);
  if (/^(cd|disc|disk)[ ._-]*\d+$/i.test(path.basename(folder))) folder = path.dirname(folder);
  const title = (tags.title || path.basename(relative, path.extname(relative))).slice(0,512);
  const album = (tags.album || path.basename(folder) || 'Unknown album').slice(0,512);
  const albumId = hash(`album\0${folder}\0${albumArtist}\0${album}`);
  const genres = (tags.genre || 'Uncategorized').split(/[;,]/).map(value => value.trim().slice(0,128)).filter(Boolean).slice(0,32);
  const dsd = /^dsd|^dst$/i.test(audio.codec_name || '');
  if (!Number.isFinite(Number(audio.sample_rate)) || Number(audio.sample_rate) <= 0) throw new Error('Unknown sample rate');
  const format = {
    codec: audio.codec_name || 'unknown', container: path.extname(relative).slice(1).toLowerCase(),
    sampleRate: Number(audio.sample_rate) * (dsd ? 8 : 1),
    bitDepth: dsd ? 1 : Number(audio.bits_per_raw_sample || audio.bits_per_sample) || undefined,
    channels: Number(audio.channels) || 2,
  };
  return {
    id: hash(relative), path: relative, title, artist, albumArtist, album, albumId,
    artistId: hash(`artist\0${albumArtist}`),
    genres, genreIds: genres.map(name => hash(`genre\0${name}`)),
    durationMs: Math.round(Number(probe.format?.duration || audio.duration || 0) * 1000),
    number: parseInt(tags.track || tags.tracknumber || '0',10) || 0,
    disc: parseInt(tags.disc || tags.discnumber || '1',10) || 1,
    year: parseInt(tags.date || tags.year || '',10) || undefined,
    format, dsd,
  };
}
// Track tags sometimes put a guest in ALBUMARTIST or append a track's radio
// edit label to ALBUM. Reconcile only matching titles within the same folder;
// different physical editions and bonus discs retain their own identities.
function reconcileAlbumTags() {
  const groups = new Map();
  const normalized = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const artistKey = value => normalized(value).replace(/^the\s+/, '').replace(/\s+feat(?:uring)?\.?\s+.*$/, '');
  for (const row of db.prepare('SELECT id,metadata FROM tracks ORDER BY path').all()) {
    const item = decodeMetadata(row.metadata);
    const title = normalized(item.album).replace(/\s*\(radio edit\)$/, '');
    const key = JSON.stringify([path.dirname(item.path), title, artistKey(item.albumArtist)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, item });
  }
  const update = db.prepare('UPDATE tracks SET metadata=? WHERE id=?');
  const copyFavorite = db.prepare('INSERT OR IGNORE INTO favorites(device_id,item_id) SELECT device_id,? FROM favorites WHERE item_id=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const members of groups.values()) {
      const counts = new Map();
      for (const { item } of members) counts.set(item.albumId, (counts.get(item.albumId) || 0) + 1);
      if (counts.size < 2) continue;
      const selected = [...counts].sort((a,b) => b[1] - a[1])[0][0];
      // A tie gives no evidence which tag is correct.
      if ([...counts.values()].filter(count => count === counts.get(selected)).length > 1) continue;
      const canonical = members.find(({ item }) => item.albumId === selected).item;
      for (const { row, item } of members) {
        if (item.albumId === selected) continue;
        copyFavorite.run(selected, item.albumId);
        Object.assign(item, { albumId: selected, album: canonical.album, albumArtist: canonical.albumArtist, artistId: canonical.artistId });
        update.run(JSON.stringify(item), row.id); version++;
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export async function scanLibrary() {
  if (scanStatus.running) { pendingScan = true; return; }
  Object.assign(scanStatus, { running: true, scanned: 0, errors: 0 });
  const seen = new Set(), cueFiles=[], splitFolders=[]; let complete = true;
  const old = new Map(db.prepare('SELECT id,size,mtime FROM tracks').all().map(row => [row.id,row]));
  const insert = db.prepare('INSERT INTO tracks VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,size=excluded.size,mtime=excluded.mtime,metadata=excluded.metadata');
  let publishedAt = Date.now(), unpublished = false;
  async function walk(folder) {
    let entries;
    try { entries = await readdir(path.join(config.music, folder), { withFileTypes: true }); }
    catch { complete = false; scanStatus.errors++; return; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === SPLIT_MARKER) { splitFolders.push(folder); continue; }
      if (entry.isSymbolicLink() || (entry.name.startsWith('.') && !(entry.isDirectory() && entry.name === SPLIT_FOLDER)) || ['@eaDir','#recycle'].includes(entry.name)) continue;
      const relative = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(relative); continue; }
      if (entry.isFile() && path.extname(entry.name).toLowerCase()==='.cue') { cueFiles.push(relative); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const id = hash(relative); seen.add(id); scanStatus.scanned++;
      try {
        const info = await stat(await musicPath(relative));
        const previous = old.get(id);
        if (previous && previous.size === info.size && previous.mtime === info.mtimeMs) continue;
        const item = await metadata(relative);
        insert.run(item.id, relative, info.size, info.mtimeMs, JSON.stringify(item));
        // New files show up every few seconds during a large scan; a revision per
        // file would make every app request rebuild the whole library meanwhile.
        if (Date.now() - publishedAt >= 5000) { version++; publishedAt = Date.now(); } else unpublished = true;
      } catch { scanStatus.errors++; console.warn(`Could not index: ${relative}`); }
      // Yield between files; metadata probing stays outside the HTTP event loop.
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  try {
    await walk('');
    if (unpublished) version++;
    if (complete) for (const id of old.keys()) if (!seen.has(id)) { db.prepare('DELETE FROM tracks WHERE id=?').run(id); version++; }
    reconcileAlbumTags();
    const sources=new Map(getCatalog().map(item=>[path.normalize(item.path).toLowerCase(),item]));
    const cueInsert=db.prepare('INSERT OR REPLACE INTO cue_tracks VALUES (?,?,?,?)');
    for(const relative of cueFiles.sort()) {
      try {
        const items=await readCue(await musicPath(relative),relative,sources,hash);
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare('DELETE FROM cue_tracks WHERE cue_path=?').run(relative); for(const item of items) cueInsert.run(item.id,relative,item.sourceId,JSON.stringify(item)); db.exec('COMMIT'); version++; }
        catch(error) { db.exec('ROLLBACK'); throw error; }
      } catch(error) { db.prepare('DELETE FROM cue_tracks WHERE cue_path=?').run(relative); version++; scanStatus.errors++; console.warn(`CUE skipped: ${relative}: ${error.message}`); }
    }
    const splitInsert=db.prepare('INSERT OR REPLACE INTO split_sets VALUES (?,?,?)');
    for(const folder of splitFolders) {
      try { const marker=JSON.parse(await readFile(path.join(await musicPath(folder),SPLIT_MARKER),'utf8')); splitInsert.run(folder,String(marker.source),JSON.stringify(marker)); version++; }
      catch(error) { db.prepare('DELETE FROM split_sets WHERE folder=?').run(folder); version++; console.warn(`Split folder skipped: ${folder}: ${error.message}`); }
    }
    if(complete) {
      const keepSplit=new Set(splitFolders);
      for(const row of db.prepare('SELECT folder FROM split_sets').all()) if(!keepSplit.has(row.folder)) { db.prepare('DELETE FROM split_sets WHERE folder=?').run(row.folder); version++; }
      const keep=new Set(cueFiles);
      for(const row of db.prepare('SELECT DISTINCT cue_path FROM cue_tracks').all()) if(!keep.has(row.cue_path)) { db.prepare('DELETE FROM cue_tracks WHERE cue_path=?').run(row.cue_path); version++; }
      db.prepare('DELETE FROM cue_tracks WHERE source_id NOT IN (SELECT id FROM tracks)').run();
    }
  } finally {
    Object.assign(scanStatus, { running: false, indexed: db.prepare('SELECT count(*) AS n FROM tracks').get().n, lastFinished: new Date().toISOString() });
    console.log(`Library scan: ${scanStatus.indexed} tracks, ${scanStatus.errors} errors`);
    if (pendingScan) { pendingScan = false; setImmediate(scanLibrary); }
  }
}
export function getCatalog() {
  if (catalogVersion !== version) { catalog = db.prepare('SELECT metadata FROM tracks').all().map(row => decodeMetadata(row.metadata)); catalogVersion = version; }
  return catalog;
}
export function cueTracks() {
  const rows=db.prepare('SELECT cue_tracks.metadata FROM cue_tracks JOIN tracks ON tracks.id=cue_tracks.source_id ORDER BY cue_tracks.cue_path, cue_tracks.id').all().map(row=>decodeMetadata(row.metadata));
  const chosen=new Map();
  return rows.filter(item=> { if(!chosen.has(item.sourceId)) chosen.set(item.sourceId,item.cuePath); return chosen.get(item.sourceId)===item.cuePath; }).map(applyArtistAlias);
}
// Split folders still matching their source image: folder -> source track.
// A changed or removed image makes its folder ordinary music again.
let splitVersion=-1, splitFolders=new Map(), splitPending=new Set();
function currentSplits() {
  if(splitVersion===version) return splitFolders;
  splitPending=new Set();
  const sources=new Map(getCatalog().map(item=>[item.path,item]));
  const rows=new Map(db.prepare('SELECT path,size,mtime FROM tracks').all().map(row=>[row.path,row]));
  splitFolders=new Map();
  for(const row of db.prepare('SELECT folder,source_path,metadata FROM split_sets').all()) {
    const marker=JSON.parse(row.metadata), source=sources.get(row.source_path), file=rows.get(row.source_path);
    if(marker.complete===true && source && file && marker.size===file.size && marker.mtime===file.mtime) splitFolders.set(row.folder,source);
    else splitPending.add(row.folder);
  }
  splitVersion=version; return splitFolders;
}
function localBrowsing() { return cached('local',buildLocalBrowsing); }
function buildLocalBrowsing() {
  const chapters=new Map(cueTracks().map(item=>[item.sourceId,item])), splits=currentSplits();
  // An unfinished or outdated split folder is hidden, never a duplicate album.
  return getCatalog().filter(item=>!splitPending.has(path.dirname(item.path))).map(item=> {
    const cue=chapters.get(item.id);
    if(cue) return applyArtistAlias({...item,album:cue.album,albumArtist:cue.albumArtist,artistId:cue.artistId});
    // Split tracks belong to the image's album, shown with its CUE album name.
    const source=splits.get(path.dirname(item.path));
    if(source) { const album=chapters.get(source.id) || source; return applyArtistAlias({...item,albumId:source.albumId,album:album.album,albumArtist:album.albumArtist,artistId:album.artistId,splitOf:source.id,splitSource:source.path}); }
    return applyArtistAlias(item);
  });
}
// Linked servers (peers.mjs keeps peer_tracks in sync with their shared index).
// Each remote track gets its own ID here. A song this library (or a server
// linked earlier) already has is hidden; remote tracks of an album that exists
// here join that album, so a bonus track never becomes a duplicate album.
const matchKey=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\[[^\]]*\]|\{[^}]*\}/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const albumKey=item=>matchKey(item.albumArtist)+'\0'+matchKey(item.album);
const songKey=item=>albumKey(item)+'\0'+(item.disc||1)+'\0'+matchKey(item.title);
export const linkedId=(peerId,id)=>hash(`peer\0${peerId}\0${id}`);
let remoteRevision='', remote={tracks:[],byId:new Map(),albums:new Map(),local:new Set(),stats:new Map()};
function remoteCatalog() {
  if(remoteRevision===libraryRevision()) return remote;
  remoteRevision=libraryRevision();
  const local=localAlbumTracks(null), albums=new Map(), songs=new Set(), next={tracks:[],byId:new Map(),albums:new Map(),local:new Set(),stats:new Map()};
  for(const item of local) { if(!albums.has(albumKey(item))) albums.set(albumKey(item),item); songs.add(songKey(item)); next.local.add(item.albumId); next.local.add(item.id); next.local.add(item.artistId); for(const id of item.genreIds) next.local.add(id); }
  const rows=db.prepare('SELECT peers.id AS peer,peers.name,peer_tracks.remote_id,peer_tracks.metadata FROM peer_tracks JOIN peers ON peers.id=peer_tracks.peer_id ORDER BY peers.created,peers.id,peer_tracks.rowid').all();
  for(let start=0;start<rows.length;) {
    // Within one server its own album identities hold (two editions stay two
    // albums); matching applies against this library and earlier servers only.
    const peer=rows[start].peer, ownAlbums=new Map(), ownSongs=new Set(), stats={tracks:0,shown:0,duplicates:0,merged:0};
    next.stats.set(peer,stats);
    for(;start<rows.length && rows[start].peer===peer;start++) {
      const row=rows[start], {imageTag,artistImageTag,...item}=JSON.parse(row.metadata), song=songKey(item); stats.tracks++;
      if(songs.has(song)) { stats.duplicates++; continue; }
      ownSongs.add(song);
      const artistId=hash(`artist\0${item.albumArtist}`), existing=albums.get(albumKey(item));
      let track={...item,id:linkedId(peer,row.remote_id),artistId,genreIds:item.genres.map(name=>hash(`genre\0${name}`)),remote:{peer,name:row.name,id:row.remote_id,artistId,albumTag:imageTag||'front-v3',artistTag:artistImageTag||'artist-v3'}};
      // A track joining an album here shows this library's cover for it.
      if(existing) { track={...track,albumId:existing.albumId,album:existing.album,albumArtist:existing.albumArtist,artistId:existing.artistId}; track.remote.albumTag=existing.remote?.albumTag; if(!existing.remote) stats.merged++; }
      else { track.albumId=linkedId(peer,item.albumId); next.albums.set(track.albumId,{peer,id:item.albumId,tag:track.remote.albumTag}); if(!ownAlbums.has(albumKey(item))) ownAlbums.set(albumKey(item),track); }
      track=applyArtistAlias(track);
      next.tracks.push(track); next.byId.set(track.id,track); stats.shown++;
    }
    for(const [key,track] of ownAlbums) if(!albums.has(key)) albums.set(key,track);
    for(const song of ownSongs) songs.add(song);
  }
  remote=next; return remote;
}
// Changes whenever the local library, the linked tracks or artist merges change.
export const libraryRevision=()=>`${version}:${stateRevision}`;
// Browsing lists are built once per library revision and shared by every
// request and client, instead of being rebuilt from the database each time.
// Callers treat them as read-only.
let memoRevision='', memo=new Map();
function cached(key, build) {
  const revision=libraryRevision();
  if(memoRevision!==revision) { memo=new Map(); memoRevision=revision; }
  if(!memo.has(key)) memo.set(key,build());
  return memo.get(key);
}
const collator=new Intl.Collator('en',{numeric:true});
const byTitle=(a,b)=>collator.compare(a.title,b.title) || (a.ref.itemId<b.ref.itemId?-1:a.ref.itemId>b.ref.itemId?1:0);
// Position in its cached list, so a page sorts by number, not by collation.
const listOrder=new WeakMap(), searchKeys=new WeakMap();
function ordered(items) {
  [...items].sort(byTitle).forEach((item,index)=>listOrder.set(item,index));
  return items;
}
function searchKey(item) {
  let key=searchKeys.get(item);
  if(key===undefined) { key=`${item.title} ${item.artist || ''} ${item.album || ''}`.normalize('NFKC').toLowerCase(); searchKeys.set(item,key); }
  return key;
}
export function libraryChanged() { version++; }
export const linkedStats=()=>remoteCatalog().stats;
// Artwork for linked items: the server and its own ID for the item. Artists and
// genres use local artwork when this library has them.
export function linkedArtwork(id) {
  const {byId,albums,tracks,local}=remoteCatalog();
  const track=byId.get(id);
  if(track) return {peer:track.remote.peer,id:track.remote.id,tag:track.remote.albumTag};
  if(albums.has(id)) return albums.get(id);
  if(local.has(id)) return null;
  const owner=tracks.find(item=>item.artistId===id || item.genreIds.includes(id));
  return owner ? {peer:owner.remote.peer,id:owner.artistId===id?owner.remote.artistId:id,tag:owner.artistId===id?owner.remote.artistTag:'genre'} : null;
}
// A linked server that shares this artist, also when this library has the artist.
export function linkedArtist(id) {
  const owner=remoteCatalog().tracks.find(item=>item.artistId===id);
  return owner ? {peer:owner.remote.peer,id:owner.remote.artistId,tag:owner.remote.artistTag} : null;
}
// Artwork versions for linked items follow their server's, so app caches refresh.
const albumTag=item=>artworkTag(item.albumId,item.remote?.albumTag?'linked-'+item.remote.albumTag:'front-v3');
function browsingCatalog() { return cached('browsing',()=>localBrowsing().concat(remoteCatalog().tracks)); }
// File type families for the library filter (the app's format badges match).
export const formatFamilies = ['flac','dsd','mp3','alac','aac','pcm'];
export function formatFamily(format = {}) {
  const codec = String(format.codec || '').toLowerCase(), container = String(format.container || '').toLowerCase();
  if (/^dsd|^dst$/.test(codec) || /^(dsf|dff|dsdiff)$/.test(container)) return 'dsd';
  if (codec === 'alac') return 'alac';
  if (/^aac/.test(codec)) return 'aac';
  if (/^pcm/.test(codec) || /^(wav|wave|aif|aiff|aifc)$/.test(container)) return 'pcm';
  const value = codec && codec !== 'unknown' ? codec : container;
  return /mp3/.test(value) ? 'mp3' : /flac/.test(value) ? 'flac' : 'other';
}
// Artists or genres with at least one track of that family.
export function idsWithFormat(kind, family) { return cached(`format:${kind}:${family}`,()=>buildIdsWithFormat(kind,family)); }
function buildIdsWithFormat(kind, family) {
  const ids = new Set();
  for (const track of browsingCatalog()) if (formatFamily(track.format) === family) {
    if (kind === 'artists') ids.add(track.artistId); else for (const id of track.genreIds) ids.add(id);
  }
  return ids;
}
// What this server shares with linked servers: its own tracks only, never
// tracks it received from another server, so links can never loop.
export function sharedTracks() {
  return localAlbumTracks(null).map(item=>({id:item.id,title:item.title,artist:item.artist,albumArtist:item.albumArtist,album:item.album,albumId:item.albumId,genres:item.genres,durationMs:item.durationMs,
    number:item.number,disc:item.disc,year:item.year,format:item.format,dsd:item.dsd===true,...(item.segment?{segment:item.segment}:{}),
    // Artwork versions: a cover or photo found later changes them, so linked servers refresh it.
    imageTag:artworkTag(item.albumId,'front-v3'),artistImageTag:artworkTag(item.artistId,'artist-v3')}));
}
export const catalogHas=id=>Boolean(getTrack(id)) || browsingCatalog().some(item=>item.albumId===id || item.artistId===id || item.genreIds.includes(id));
// 'full': the original files (album images, never their split copies).
// 'chapters': split tracks where an album was split, CUE chapters otherwise.
// Linked tracks are listed as their server shares them, in both layouts.
export function albumTracks(albumId, layout='chapters') {
  if(!albumId) return cached('tracks:'+layout,()=>localAlbumTracks(null,layout).concat(remoteCatalog().tracks));
  return localAlbumTracks(albumId,layout).concat(remoteCatalog().tracks.filter(item=>!albumId || item.albumId===albumId));
}
function localAlbumTracks(albumId, layout='chapters') {
  const originals=localBrowsing().filter(item=>!albumId || item.albumId===albumId);
  if(layout==='full') return originals.filter(item=>!item.splitOf);
  const split=new Set([...currentSplits().values()].map(item=>item.id));
  const all=cueTracks().filter(item=>!albumId || item.albumId===albumId);
  const replaced=new Set(all.map(item=>item.sourceId));
  return originals.filter(item=>!replaced.has(item.id)).concat(all.filter(item=>!split.has(item.sourceId)));
}
// Mixes use real files only: native tracks and server-split tracks.
export const mixTracks = () => albumTracks(null).filter(item=>!item.segment);
// Track IDs are hashes of the path. Split tracks moved from Tracks/ to the
// hidden folder in 0.1.23; their earlier IDs (cached mixes, favorites, history
// on clients) keep resolving to the same file.
let movedCatalog, movedIds=new Map();
function movedTrackIds() {
  const catalog=getCatalog();
  if(catalog!==movedCatalog) {
    movedIds=new Map();
    for(const item of catalog) {
      const parts=item.path.split(path.sep), index=parts.lastIndexOf(SPLIT_FOLDER);
      if(index<0) continue;
      parts[index]=LEGACY_SPLIT_FOLDER; movedIds.set(hash(parts.join(path.sep)),item.id);
    }
    // Carry favorites saved under an earlier ID over to the moved track.
    const move=db.prepare('UPDATE OR IGNORE favorites SET item_id=? WHERE item_id=?');
    for(const [previous,current] of movedIds) move.run(current,previous);
    movedCatalog=catalog;
  }
  return movedIds;
}
export function getTrack(id) {
  let row=db.prepare('SELECT * FROM tracks WHERE id=?').get(id) || (movedTrackIds().has(id) && db.prepare('SELECT * FROM tracks WHERE id=?').get(movedTrackIds().get(id)));
  if(row) return applyArtistAlias({...decodeMetadata(row.metadata),size:row.size,mtime:row.mtime});
  const cue=db.prepare('SELECT * FROM cue_tracks WHERE id=?').get(id);
  if(!cue) return remoteCatalog().byId.get(id) || null;
  row=db.prepare('SELECT * FROM tracks WHERE id=?').get(cue.source_id);
  if(row) return applyArtistAlias({...decodeMetadata(cue.metadata),path:row.path,size:row.size,mtime:row.mtime});
  return remoteCatalog().byId.get(id) || null;
}
// Every track as the apps see it, without per-device favorites (page() adds them).
export function trackViews() { return cached('trackViews',()=>ordered(albumTracks(null).map(item=>trackView(item,new Set())))); }
// Favorites of every device in the listener's profile.
export function favorites(deviceId) { movedTrackIds(); const devices = profileDevices(deviceId); return new Set(db.prepare(`SELECT item_id FROM favorites WHERE device_id IN (${marks(devices)})`).all(...devices).map(row => row.item_id)); }
export function trackView(item, favoriteIds) {
  const { path: _, id, albumArtist, artistId, genres, genreIds, dsd, sourceId, cuePath, cueTitle, splitOf, splitSource, remote, ...visible } = item;
  delete visible.size; delete visible.mtime;
  return { ...visible, ...(remote ? { linkedServer: remote.name } : {}), albumImageTag:albumTag(item), ref: ref(id), favorite: favoriteIds.has(id) };
}
export function albumViews() { return cached('albums',()=>ordered(buildAlbumViews())); }
function buildAlbumViews() {
  const groups = new Map();
  const tracks = browsingCatalog();
  // Local tracks come first: an album with tracks here is never marked linked.
  for (const track of tracks) if (!groups.has(track.albumId)) groups.set(track.albumId, { ref: ref(track.albumId), title: track.album, artist: track.albumArtist, year: track.year, imageTag:albumTag(track), artistId: track.artistId, genreIds: new Set(), ...(track.remote ? { linkedServer: track.remote.name } : {}) });
  for (const track of tracks) for (const id of track.genreIds) groups.get(track.albumId).genreIds.add(id);
  // Aggregate indexed source formats in one pass; album browsing/search needs
  // no per-album requests, disk reads or media probing.
  const formats=new Map();
  for(const track of tracks) {
    let values=formats.get(track.albumId); if(!values) formats.set(track.albumId,values=new Map());
    if(track.format) values.set(`${track.format.codec}:${track.format.container}`,{codec:track.format.codec,container:track.format.container});
  }
  for(const album of groups.values()) album.formats=[...(formats.get(album.ref.itemId)?.values() || [])];
  for(const track of cueTracks()) { const album=groups.get(track.albumId); if(album) album.cueTrackCount=(album.cueTrackCount||0)+1; }
  return [...groups.values()];
}
export function groupViews(kind) { return cached('groups:'+kind,()=>ordered(buildGroupViews(kind))); }
function buildGroupViews(kind) {
  const groups = new Map();
  for (const track of browsingCatalog()) {
    if (kind === 'artists') { if (!track.remote || !groups.has(track.artistId)) groups.set(track.artistId, { ref: ref(track.artistId), title: track.albumArtist, kind, imageTag:artworkTag(track.artistId,track.remote?'linked-'+track.remote.artistTag:'artist-v3'), ...(track.remote ? { linkedServer: track.remote.name } : {}) }); }
    else track.genres.forEach((name,index) => groups.set(track.genreIds[index], { ref: ref(track.genreIds[index]), title: name, kind, imageTag:'genre-v3' }));
  }
  return [...groups.values()];
}
export function page(items, query, favoriteIds) {
  const search = (query.get('search') || '').trim().normalize('NFKC').toLowerCase();
  let result = search ? items.filter(item => searchKey(item).includes(search)) : items;
  if (query.get('favorites') === 'true') result = result.filter(item => favoriteIds.has(item.ref.itemId));
  result = result === items ? [...items] : result;
  if (result.every(item => listOrder.has(item))) result.sort((a,b) => listOrder.get(a) - listOrder.get(b));
  else result.sort(byTitle);
  const total = result.length;
  const start = Math.max(0, Math.min(10000000, Number(query.get('startIndex')) || 0));
  const limit = Math.max(1, Math.min(200, Number(query.get('limit')) || 48));
  return { items: result.slice(start, start + limit).map(({artistId,genreIds,...item}) => ({ ...item, favorite: favoriteIds.has(item.ref.itemId) })), total };
}
let scanRequest = getSetting('scan.request');
setInterval(() => { const next = getSetting('scan.request'); if (next !== scanRequest) { scanRequest = next; void scanLibrary(); } }, 2000).unref();
async function renderArtwork(id, portraitOnly=false) {
  const tracks=browsingCatalog();
  const track=tracks.find(item=>!item.remote && (item.id===id || item.albumId===id || item.artistId===id || item.genreIds.includes(id))) || getTrack(id);
  if(!track || track.remote) return null;
  const artist=id===track.artistId;
  const source=await musicPath(track.splitSource || track.path), folder=path.dirname(source);
  let selected=null, isArtistPhoto=false;
  const entries=await readdir(folder);
  const pick=(names,patterns)=>patterns.map(pattern=>names.find(name=>pattern.test(name))).find(Boolean);
  if(artist) {
    let current=folder;
    for(let depth=0;depth<3;depth++) {
      const names=await readdir(current);
      const name=pick(names,[/^artist\.(jpg|jpeg|png|webp)$/i,/^portrait\.(jpg|jpeg|png|webp)$/i,/^fanart\.(jpg|jpeg|png|webp)$/i]);
      if(name) { selected=await musicPath(path.relative(config.music,path.join(current,name))); isArtistPhoto=true; break; }
      const parent=path.dirname(current);
      if(parent===config.music || parent===current || !parent.startsWith(config.music+path.sep)) break;
      current=parent;
    }
  }
  if(artist && portraitOnly && !selected) return null;
  if(!selected) {
    const cover=pick(entries,[/^front\.(jpg|jpeg|png|webp)$/i,/^cover\.(jpg|jpeg|png|webp)$/i,/^folder\.(jpg|jpeg|png|webp)$/i,/^(album|albumart|cover[ _-]?front)\.(jpg|jpeg|png|webp)$/i]);
    if(cover) selected=await musicPath(path.relative(config.music,path.join(folder,cover)));
    if(!selected) for(const subfolder of entries.filter(name=>/^(covers?|artwork|scans?)$/i.test(name))) {
      const location=path.join(folder,subfolder);
      let names; try { names=await readdir(location); } catch { continue; }
      const front=pick(names,[/^(front|cover|folder)\.(jpg|jpeg|png|webp)$/i,/(^|[ _.-])front([ _.-].*)?\.(jpg|jpeg|png|webp)$/i]);
      if(front) { selected=await musicPath(path.relative(config.music,path.join(location,front))); break; }
    }
    if(!selected && /^(cd|disc|disk)[ ._-]*\d+$/i.test(path.basename(folder))) {
      const parent=path.dirname(folder), names=await readdir(parent);
      const cover=pick(names,[/^front\.(jpg|jpeg|png|webp)$/i,/^cover\.(jpg|jpeg|png|webp)$/i,/^folder\.(jpg|jpeg|png|webp)$/i]);
      if(cover) selected=await musicPath(path.relative(config.music,path.join(parent,cover)));
    }
  }
  const info=await stat(selected||source);
  const image=path.join(cacheDir,`${id}-${hash(`${selected||source}:${info.size}:${info.mtimeMs}:front-v3`).slice(0,16)}.jpg`);
  try { await stat(image); return image; } catch {}
  // A typical open CD sleeve is back (left) + front (right). Select the entire front,
  // then fit it within the square instead of taking the middle of the spread.
  const crop=isArtistPhoto?'':"crop=w='if(gte(iw/ih,1.7),iw/2,iw)':h=ih:x='if(gte(iw/ih,1.7),iw/2,0)':y=0,";
  const filter=crop+'scale=600:600:force_original_aspect_ratio=decrease';
  try {
    const args=['-v','error','-nostdin','-y','-protocol_whitelist','file','-i',selected||source];
    if(!selected) args.push('-map','0:v:0');
    args.push('-vf',filter,'-frames:v','1','-f','image2',image);
    await processFile('ffmpeg',args); return image;
  } catch { await unlink(image).catch(()=>{}); return null; }
}

const artworkJobs = new Map();
let artworkActive = 0;
const artworkWaiting = [];
export async function artworkPath(id, {portraitOnly=false, localOnly=false}={}) {
  const artist=canonicalArtist(id,'');
  const track=getTrack(id);
  const override=storedArtwork(artist.id) || (track && storedArtwork(track.albumId));
  if(override && !localOnly) {try {await stat(override.path);return override.path;}catch{}}
  id=artist.id;
  const key=id+':'+portraitOnly;
  if (artworkJobs.has(key)) return artworkJobs.get(key);
  if (artworkWaiting.length >= 128) return null;
  const job = (async () => {
    if (artworkActive >= 2) await new Promise(resolve => artworkWaiting.push(resolve));
    else artworkActive++;
    try { return await renderArtwork(id,portraitOnly); }
    finally { const next = artworkWaiting.shift(); if (next) next(); else artworkActive--; }
  })().finally(() => artworkJobs.delete(key));
  artworkJobs.set(key,job);
  return job;
}
