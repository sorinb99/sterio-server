import { readdir, stat, realpath, mkdir, unlink, readFile } from 'node:fs/promises';
import { marks, profileDevices } from './profiles.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.mjs';
import { db, hash, getSetting, setSetting } from './db.mjs';
import { readCue } from './cue.mjs';
import { readSacd, sacdTracks } from './sacd.mjs';
import { applyArtistAlias, canonicalArtist, storedArtwork, artworkTag, stateRevision } from './library-state.mjs';
const extensions = new Set(['.mp3','.flac','.m4a','.aac','.alac','.wav','.aif','.aiff','.ogg','.opus','.dsf','.dff','.dsdiff']);
export const cacheDir = path.join(config.data, 'cache');
// Server-split CUE albums: a hidden folder of ordinary FLAC tracks inside the
// album, so file browsers and other players (SMB, Finder) don't list them twice.
export const SPLIT_FOLDER = '.sterio-tracks', LEGACY_SPLIT_FOLDER = 'Tracks', SPLIT_MARKER = '.sterio-split.json';
await mkdir(cacheDir, { recursive: true });
let version = 0, catalogVersion = -1, catalog = [];
export const scanStatus = { running: false, scanned: 0, indexed: 0, errors: 0, lastFinished: null };
// Disc images the last scan found that are not SACDs (DVD, data discs):
// listed on the dashboard, never counted as scan errors.
export const sacdSkipped = new Map();
let pendingScan = false;
// CUE files read by an earlier scan of this run (path -> size:mtime, and
// whether it was skipped, so the error count stays the same). A scan
// that indexed no audio change rereads only the CUE files that changed, so
// the scan every 15 minutes rewrites nothing and the library stays the same
// revision (apps and artwork have nothing to redo).
const cueRead = new Map();
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
  const seen = new Set(), cueFiles=[], splitFolders=[], isoFiles=[]; let complete = true;
  const old = new Map(db.prepare('SELECT id,path,size,mtime FROM tracks').all().map(row => [row.id,row]));
  const insert = db.prepare('INSERT INTO tracks VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,size=excluded.size,mtime=excluded.mtime,metadata=excluded.metadata');
  let publishedAt = Date.now(), unpublished = false, audioChanged = false;
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
      if (entry.isFile() && path.extname(entry.name).toLowerCase()==='.iso') { isoFiles.push(relative); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const id = hash(relative); seen.add(id); scanStatus.scanned++;
      try {
        const info = await stat(await musicPath(relative));
        const previous = old.get(id);
        if (previous && previous.size === info.size && previous.mtime === info.mtimeMs) continue;
        const item = await metadata(relative);
        insert.run(item.id, relative, info.size, info.mtimeMs, JSON.stringify(item)); audioChanged = true;
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
    // SACD images: one track per track of the disc's stereo area, read from
    // the disc's tables (sacd.mjs). An unchanged image keeps its tracks.
    const byImage=new Map();
    for(const row of old.values()) { const at=row.path.lastIndexOf('.iso#'); if(at>0) { const image=row.path.slice(0,at+4); if(!byImage.has(image)) byImage.set(image,[]); byImage.get(image).push(row); } }
    const skipped=new Map();
    for(const relative of isoFiles.sort()) {
      try {
        const info=await stat(await musicPath(relative)), known=byImage.get(relative)||[];
        if(known.length && known.every(row=>row.size===info.size && row.mtime===info.mtimeMs)) { for(const row of known) { seen.add(row.id); scanStatus.scanned++; } continue; }
        const items=sacdTracks(relative,await readSacd(await musicPath(relative)),info.size,info.mtimeMs,hash);
        if(!items.length) throw new Error('No stereo area');
        for(const item of items) { seen.add(item.id); scanStatus.scanned++; insert.run(item.id,item.path,info.size,info.mtimeMs,JSON.stringify(item)); }
        version++; audioChanged=true;
      } catch(error) { skipped.set(relative,error.message); }
      await new Promise(resolve => setImmediate(resolve));
    }
    sacdSkipped.clear(); for(const [relative,reason] of skipped) sacdSkipped.set(relative,reason);
    if (unpublished) version++;
    if (complete) for (const id of old.keys()) if (!seen.has(id)) { db.prepare('DELETE FROM tracks WHERE id=?').run(id); version++; audioChanged = true; }
    reconcileAlbumTags();
    const sources=new Map(getCatalog().map(item=>[path.normalize(item.path).toLowerCase(),item]));
    const cueInsert=db.prepare('INSERT OR REPLACE INTO cue_tracks VALUES (?,?,?,?)');
    for(const relative of cueFiles.sort()) {
      const cueInfo=await stat(await musicPath(relative)).catch(() => null), cueKey=cueInfo ? `${cueInfo.size}:${cueInfo.mtimeMs}` : '';
      const known=cueRead.get(relative);
      if(!audioChanged && cueKey && known?.key===cueKey) { if(known.failed) scanStatus.errors++; continue; }
      const read={key:cueKey,failed:false}; cueRead.set(relative,read);
      try {
        const items=await readCue(await musicPath(relative),relative,sources,hash);
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare('DELETE FROM cue_tracks WHERE cue_path=?').run(relative); for(const item of items) cueInsert.run(item.id,relative,item.sourceId,JSON.stringify(item)); db.exec('COMMIT'); version++; }
        catch(error) { db.exec('ROLLBACK'); throw error; }
      } catch(error) { read.failed=true; db.prepare('DELETE FROM cue_tracks WHERE cue_path=?').run(relative); version++; scanStatus.errors++; console.warn(`CUE skipped: ${relative}: ${error.message}`); }
    }
    const splitInsert=db.prepare('INSERT OR REPLACE INTO split_sets VALUES (?,?,?)');
    for(const folder of splitFolders) {
      try {
        const marker=JSON.parse(await readFile(path.join(await musicPath(folder),SPLIT_MARKER),'utf8')), saved=db.prepare('SELECT source_path,metadata FROM split_sets WHERE folder=?').get(folder);
        if(saved?.source_path===String(marker.source) && saved.metadata===JSON.stringify(marker)) continue;
        splitInsert.run(folder,String(marker.source),JSON.stringify(marker)); version++;
      }
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
// Automatic scans: every hour unless the administrator picks another interval
// in the dashboard or the app (0 turns them off; Scan library always works).
// Until then SCAN_INTERVAL_SECONDS decides.
export const scanIntervals = [0, 15, 60, 360, 1440];
export function scanIntervalMinutes() {
  const saved = getSetting('scan.intervalMinutes');
  return saved !== undefined && scanIntervals.includes(Number(saved)) ? Number(saved) : Math.max(1, Math.round(config.scanSeconds / 60));
}
export function setScanInterval(minutes) {
  if (!scanIntervals.includes(minutes)) return false;
  setSetting('scan.intervalMinutes', minutes); return true;
}
// Checked once a minute: a scan starts when the chosen interval has passed
// since the last one finished, so a manual scan also resets the wait.
export function scanWhenDue() {
  const minutes = scanIntervalMinutes();
  if (!minutes || scanStatus.running || !scanStatus.lastFinished) return;
  if (Date.now() - Date.parse(scanStatus.lastFinished) >= minutes * 60000) void scanLibrary();
}
export function getCatalog() {
  if (catalogVersion !== version) { catalog = db.prepare('SELECT metadata FROM tracks').all().map(row => decodeMetadata(row.metadata)); catalogVersion = version; }
  return catalog;
}
export function cueTracks() { return cached('cueTracks',()=>rawCueTracks().map(discForm)); }
function rawCueTracks() {
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
const chaptersBySource=()=>cached('chaptersBySource',()=>new Map(rawCueTracks().map(item=>[item.sourceId,item])));
// A file as the library shows it: an image with its CUE album name, a split
// track in the image's album (its cover, its artist).
function browsingForm(item) { return discForm(browsingFormOf(item)); }
function browsingFormOf(item) {
  const chapters=chaptersBySource(), cue=chapters.get(item.id);
  if(cue) return applyArtistAlias({...item,album:cue.album,albumArtist:cue.albumArtist,artistId:cue.artistId});
  const source=currentSplits().get(path.dirname(item.path));
  if(source) { const album=chapters.get(source.id) || source; return applyArtistAlias({...item,albumId:source.albumId,album:album.album,albumArtist:album.albumArtist,artistId:album.artistId,splitOf:source.id,splitSource:source.path}); }
  return applyArtistAlias(item);
}
function buildLocalBrowsing() {
  currentSplits();
  // An unfinished or outdated split folder is hidden, never a duplicate album.
  return getCatalog().filter(item=>!splitPending.has(path.dirname(item.path))).map(browsingForm);
}
// Multi-disc albums: the discs of one album sit in folders such as "CD 1",
// "Disc 2", "CD 02 - Covers" or "Album (Deluxe) CD 2", often tagged
// "Album CD1" / "Album (Disc 2)" or with no disc number at all. Their tracks
// join one album (the lowest disc's ID, so favorites stay), titled without the
// disc marker, each track keeping its disc. A folder named only by its disc
// ("CD1", "Disc 2 - Covers") belongs to its parent album whatever the tags say;
// one that only ends with a disc number joins discs whose titles match.
const discMarker=/^(?:cd|disc|disk)[ ._-]*(\d{1,2})(?!\d)(?:\s*[-–:.]\s*(\D*))?$/i;
const discSuffix=/[ ._-](?:cd|disc|disk)[ ._-]*(\d{1,2})$/i;
export function discFolder(name) {
  let match=name.match(discMarker);
  if(match) return {disc:Number(match[1]),title:(match[2]||'').trim(),only:true};
  match=name.match(discSuffix);
  return match ? {disc:Number(match[1]),title:'',only:false} : null;
}
export const withoutDisc=title=>title
  .replace(/\s*[([]\s*(?:cd|disc|disk)[ ._-]*\d{1,2}\s*[)\]]/gi,'')
  .replace(/[\s,]*(?:cd|disc|disk)[ ._-]*\d{1,2}(?=\s*[)\]])/gi,'')
  .replace(/[\s,:–-]*(?:cd|disc|disk)[ ._-]*\d{1,2}\s*$/i,'')
  .trim() || title.trim();
// Compilations and soundtracks without an ALBUMARTIST tag ("Eminem Presents:
// The Re-Up", "8 Mile") would become one album per track artist: tracks in one
// folder with one album title are one album. Its artist is the one the title
// names, else the one with most tracks, else Various Artists.
function albumPlace(item) {
  if(item.remote) return null;
  const folder=path.dirname(item.splitSource || item.path || ''), found=discFolder(path.basename(folder));
  if(!found) return {key:`${folder}\0${matchKey(item.album)}`,disc:item.disc||1};
  const album=path.dirname(folder);
  return {...found,key:found.only ? album : `${album}\0${matchKey(withoutDisc(item.album))}`,disc:item.disc>1 ? item.disc : found.disc};
}
function albumArtistOf(title, counts) {
  if(counts.size<2) return null;
  const named=[...counts.keys()].filter(name=>matchKey(name) && ` ${matchKey(title)} `.includes(` ${matchKey(name)} `));
  if(named.length) return named.sort((a,b)=>counts.get(b)-counts.get(a))[0];
  const [first,second]=[...counts].sort((a,b)=>b[1]-a[1]);
  return first[1]>second[1] ? first[0] : 'Various Artists';
}
// Each album's ID (its lowest disc's, the chosen artist's), title and artist.
function albumGroups() {
  return cached('albumGroups',()=>{
    const groups=new Map();
    for(const item of getCatalog().map(browsingFormOf).concat(rawCueTracks())) {
      const place=albumPlace(item); if(!place) continue;
      let group=groups.get(place.key);
      if(!group) groups.set(place.key,group={members:[],counts:new Map(),artists:new Set(),disc:Boolean(place.only!==undefined)});
      group.members.push({disc:place.disc,albumId:item.albumId,album:item.album,albumArtist:item.albumArtist});
      if(!group.artists.has(matchKey(item.albumArtist))) { group.artists.add(matchKey(item.albumArtist)); group.counts.set(item.albumArtist,0); }
      const name=[...group.counts.keys()].find(value=>matchKey(value)===matchKey(item.albumArtist));
      group.counts.set(name,group.counts.get(name)+1);
    }
    const result=new Map();
    for(const [key,group] of groups) {
      if(!group.disc && group.counts.size<2 && new Set(group.members.map(m=>m.albumId)).size<2) continue;
      const lowest=Math.min(...group.members.map(m=>m.disc));
      const first=group.members.filter(m=>m.disc===lowest);
      const artist=albumArtistOf(withoutDisc(first[0].album),group.counts);
      const own=first.filter(m=>artist && matchKey(m.albumArtist)===matchKey(artist));
      const chosen=(own.length ? own : first).sort((a,b)=>a.albumId<b.albumId?-1:1)[0];
      result.set(key,{albumId:chosen.albumId,album:group.disc ? withoutDisc(chosen.album) : chosen.album,albumArtist:artist});
    }
    return result;
  });
}
function discForm(item) {
  const place=albumPlace(item); if(!place) return item;
  const album=albumGroups().get(place.key); if(!album) return item;
  const next={...item,albumId:album.albumId,album:album.album,disc:place.disc,...(place.title?{discTitle:place.title}:{})};
  if(!album.albumArtist || matchKey(album.albumArtist)===matchKey(item.albumArtist)) return next;
  return applyArtistAlias({...next,albumArtist:album.albumArtist,artistId:hash(`artist\0${album.albumArtist}`)});
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
      let track={...item,id:linkedId(peer,row.remote_id),artistId,genreIds:item.genres.map(name=>hash(`genre\0${name}`)),remote:{peer,name:row.name,id:row.remote_id,artistId,albumTag:imageTag||'front-v4',artistTag:artistImageTag||'artist-v3'}};
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
const albumTag=item=>artworkTag(item.albumId,item.remote?.albumTag?'linked-'+item.remote.albumTag:'front-v4');
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
// DST-compressed SACD tracks stay here: they play only converted to PCM, and
// a linked server asks for the original.
export function sharedTracks() {
  return localAlbumTracks(null).filter(item=>!item.sacd?.dst).map(item=>({id:item.id,title:item.title,artist:item.artist,albumArtist:item.albumArtist,album:item.album,albumId:item.albumId,genres:item.genres,durationMs:item.durationMs,
    number:item.number,disc:item.disc,year:item.year,format:item.format,dsd:item.dsd===true,...(item.segment?{segment:item.segment}:{}),
    // Artwork versions: a cover or photo found later changes them, so linked servers refresh it.
    imageTag:artworkTag(item.albumId,'front-v4'),artistImageTag:artworkTag(item.artistId,'artist-v3')}));
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
  // The same album, cover and artist as in the library (now playing, playlists, streamers).
  if(row) return browsingForm({...decodeMetadata(row.metadata),size:row.size,mtime:row.mtime});
  const cue=db.prepare('SELECT * FROM cue_tracks WHERE id=?').get(id);
  if(!cue) return remoteCatalog().byId.get(id) || null;
  row=db.prepare('SELECT * FROM tracks WHERE id=?').get(cue.source_id);
  if(row) return discForm(applyArtistAlias({...decodeMetadata(cue.metadata),path:row.path,size:row.size,mtime:row.mtime}));
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
setInterval(() => { const next = getSetting('scan.request'); if (next !== scanRequest) { scanRequest = next; cueRead.clear(); void scanLibrary(); } }, 2000).unref();
async function renderArtwork(id, portraitOnly=false) {
  const tracks=browsingCatalog();
  // A multi-disc album's cover comes from its first disc (or the album folder).
  let track=tracks.find(item=>!item.remote && (item.id===id || item.albumId===id || item.artistId===id || item.genreIds.includes(id))) || getTrack(id);
  if(track?.albumId===id && track.disc>1) track=tracks.filter(item=>!item.remote && item.albumId===id).reduce((best,item)=>(item.disc||1)<(best.disc||1) ? item : best,track);
  if(!track || track.remote) return null;
  const artist=id===track.artistId;
  // A SACD image has no picture of its own: only the folder's covers.
  const source=await musicPath(track.splitSource || track.sacd?.image || track.path), folder=path.dirname(source);
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
    // The disc's own folder first, then its album's folder: a front picture,
    // then one in an artwork subfolder (Covers, Artwork, Scans, Сканы (Russia)…).
    const folders=[folder]; if(discFolder(path.basename(folder))) folders.push(path.dirname(folder));
    for(const location of folders) {
      let names; try { names=location===folder ? entries : await readdir(location); } catch { continue; }
      const cover=pick(names,[/^front\.(jpg|jpeg|png|webp)$/i,/^cover\.(jpg|jpeg|png|webp)$/i,/^folder\.(jpg|jpeg|png|webp)$/i,/^(album|albumart|cover[ _-]?front)\.(jpg|jpeg|png|webp)$/i]);
      if(cover) { selected=await musicPath(path.relative(config.music,path.join(location,cover))); break; }
      for(const subfolder of names.filter(name=>/^(covers?|artwork|art|scans?|images?|booklet|сканы|обложк[аи])(?=$|[\s(\[_.-])/iu.test(name))) {
        const inner=path.join(location,subfolder);
        let files; try { files=await readdir(inner); } catch { continue; }
        const front=pick(files,[/^(front|cover|folder)\.(jpg|jpeg|png|webp)$/i,/(^|[ _.-])front([ _.-].*)?\.(jpg|jpeg|png|webp)$/i,/^cover([ _.-].*)?\.(jpg|jpeg|png|webp)$/i]);
        if(front) { selected=await musicPath(path.relative(config.music,path.join(inner,front))); break; }
      }
      if(selected) break;
    }
  }
  if(!selected && track.sacd) return null;
  const info=await stat(selected||source);
  const image=path.join(cacheDir,`${id}-${hash(`${selected||source}:${info.size}:${info.mtimeMs}:front-v4`).slice(0,16)}.jpg`);
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

// SACD images in the library, for the dashboard and the app.
export function sacdImages() {
  const images=new Map();
  for(const item of getCatalog()) {
    if(!item.sacd) continue;
    const image=images.get(item.sacd.image) || { path:item.sacd.image, album:item.album, artist:item.albumArtist, year:item.year, dst:item.sacd.dst, tracks:0, seconds:0 };
    image.tracks++; image.seconds+=Math.round(item.durationMs/1000); images.set(item.sacd.image,image);
  }
  return { images:[...images.values()].sort((a,b)=>a.path.localeCompare(b.path)), skipped:[...sacdSkipped].map(([path,reason])=>({ path, reason })) };
}
