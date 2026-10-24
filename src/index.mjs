import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { loadStats } from './load.mjs';
import { discoverySeed, invalidateDiscovery } from './discovery.mjs';
import { thumbnailPath, sendImage } from './images.mjs';
import { startAdmin } from './admin.mjs';
import { appAdmin } from './app-admin.mjs';
import { requestAccess } from './requests.mjs';
import { migrateSplitFolders } from './split.mjs';
import { updateDeviceNickname, recordPlayback, rememberDelivery, trackTransfer } from './reporting.mjs';
import { createLink, joinLink, pulse, sendCommand, decidePair, requestPair, setDiscoverable, unpair } from './connect.mjs';
import { acceptSocket, closeSockets } from './socket.mjs';
import { addToPlaylist, createPlaylist, deletePlaylist, getPlaylist, listPlaylists, sharePlaylist, updatePlaylist } from './playlists.mjs';
import { createProfileLink, joinProfile, leaveProfile, marks, profileDevices, profileView, renameProfile } from './profiles.mjs';
import { addRenderer, controlRenderer, discoverRenderers, externalItem, listRenderers, noteLan, lanServerBase, playOnRenderer, publicBase, removeRenderer, streamBase } from './renderers.mjs';
import { linkedSourceUrl, prepareDelivery, resolveDelivery } from './delivery.mjs';
import { isPeerClient, leavePeer, linkedArtistPhoto, linkedImage, linkedMedia, pairPeer, proxyStream, shareIndex } from './peers.mjs';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { config } from './config.mjs';
import { db, serverId, hash } from './db.mjs';
import { HttpError, limit, pairDevice, challengeDevice, createSession, authenticate, verifyTicket } from './auth.mjs';
import { scanLibrary, scanStatus, scanWhenDue, albumTracks, albumViews, groupViews, page, catalogHas, getTrack, favorites, trackView, trackViews, formatFamilies, formatFamily, idsWithFormat } from './library.mjs';
import { deliveredFormat, streamLinkedConversion, streamTrack, pruneCache } from './media.mjs';
// Large answers (album pages, search) are compressed for apps away from home.
const json = (res, status, body) => {
  const text = JSON.stringify(body);
  const gzip = text.length > 4096 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '');
  const data = gzip ? gzipSync(text, { level: 4 }) : text;
  res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control':'no-store', ...(gzip ? { 'Content-Encoding':'gzip', Vary:'Accept-Encoding' } : {}) });
  res.end(data);
};
async function body(req, maxSize = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > maxSize) throw new HttpError(413,'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400,'Invalid JSON body'); }
}
async function artwork(req,res,url,id) {
  // portrait=1 (asked by linked servers): this library's own artist photo only.
  const portrait = url.searchParams.get('portrait') === '1', width = url.searchParams.get('width');
  const linked = portrait ? undefined : await linkedImage(id,width);
  if (linked !== undefined) { if (!linked) throw new HttpError(404,'Artwork unavailable'); return await sendImage(req,res,linked); }
  const photo = portrait ? undefined : await linkedArtistPhoto(id,width);
  if (photo) return await sendImage(req,res,photo);
  const file = await thumbnailPath(id,width,{portraitOnly:portrait}); if (!file) throw new HttpError(404,'Artwork unavailable'); return await sendImage(req,res,file);
}
async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (config.tlsCert) res.setHeader('Strict-Transport-Security','max-age=31536000');
  try {
    limit('request:' + req.socket.remoteAddress,1000);
    const url = new URL(req.url, 'http://sterio.invalid');
    if (config.basePath && !url.pathname.startsWith(config.basePath + '/') && url.pathname !== config.basePath) throw new HttpError(404,'Not found');
    const route = url.pathname.slice(config.basePath.length) || '/';
    const method = req.method;
    if (method === 'GET' && route === '/healthz') return json(res,200,{status:'ok',load:loadStats()});
    if (method === 'GET' && route === '/') return json(res,200,{name:'Sterio Server',message:'Connect with the Sterio app. Generate a pairing code using the NAS command line.',api:config.basePath+'/v1/info'});
    if (method === 'GET' && route === '/v1/info') return json(res,200,{ provider:'sterio',version:'0.2.13',apiVersion:1,serverId,name:config.name,authentication:'P256-SHA256',dsd:'Original DSF/DFF with explicitly authorized server FLAC fallback',dsdPcmFallback:true,losslessFlacCompatibility:true,remoteControl:true,discovery:true,artworkThumbnails:true,radioLikes:true,administration:true,peers:true,renderers:true,phoneStreamers:true,formatFilter:true,connectSocket:true,accessRequests:true,macPairing:true,unpair:true,deviceRemoval:true });
    // Only the address is needed: an administrator accepts the request on this server.
    if (method === 'POST' && route === '/v1/auth/request') { limit('request:' + req.socket.remoteAddress,90); return json(res,200,requestAccess('device',await body(req),req.socket.remoteAddress)); }
    if (method === 'POST' && route.startsWith('/v1/auth/')) {
      limit('auth:' + req.socket.remoteAddress, route === '/v1/auth/pair' ? 10 : 60);
      const input = await body(req);
      if (route === '/v1/auth/pair') return json(res,200,pairDevice(input));
      if (route === '/v1/auth/challenge') return json(res,200,challengeDevice(input));
      if (route === '/v1/auth/session') return json(res,200,createSession(input));
    }
    if (method === 'POST' && route === '/v1/peers/request') { limit('request:' + req.socket.remoteAddress,90); return json(res,200,requestAccess('server',await body(req),req.socket.remoteAddress)); }
    if (method === 'POST' && route === '/v1/peers/pair') { limit('peer-pair:' + req.socket.remoteAddress,10); return json(res,200,pairPeer(await body(req))); }
    const stream = route.match(/^\/v1\/stream\/([a-f0-9]{64})(?:\.(?:flac|dsf|dff|mp3|m4a|wav|aif|aiff))?$/);
    if (stream && ['GET','HEAD'].includes(method)) {
      const ticket = verifyTicket(url.searchParams.get('ticket'),stream[1]);
      // A linked server streams for all of its listeners with one device key.
      limit('stream:' + ticket.d, isPeerClient(ticket.d) ? 9000 : 900);
      const linked = linkedMedia(stream[1]);
      if (linked) {
        trackTransfer(req,res,ticket.d,linked.track_id,ticket.m);
        // Converted here from the linked server's original, or streamed through as it is.
        const convert = JSON.parse(linked.request).convert, track = convert && getTrack(linked.track_id);
        if (convert && !track) throw new HttpError(404,'Track not found');
        return convert ? await streamLinkedConversion(req,res,linked.id,track,convert,linkedSourceUrl(track)) : await proxyStream(req,res,linked);
      }
      const source = getTrack(stream[1]);
      if(source && req.method==='GET') rememberDelivery(ticket.d,source.id,({verbatim:'pcm',cueverbatim:'cue'})[ticket.m]||ticket.m,['pcm','verbatim'].includes(ticket.m)?deliveredFormat(source):source.format);
      trackTransfer(req,res,ticket.d,stream[1],ticket.m);
      return await streamTrack(req,res,stream[1],ticket.m);
    }
    // Network streamers show cover art from a ticketed URL; they cannot sign in.
    const image = route.match(/^\/v1\/images\/([a-f0-9]{64})(?:\.jpg)?$/);
    if (image && ['GET','HEAD'].includes(method) && url.searchParams.has('ticket')) { verifyTicket(url.searchParams.get('ticket'),image[1]); return await artwork(req,res,url,image[1]); }
    const device = authenticate(req);
    noteLan(req);
    const peer = isPeerClient(device.id);
    limit('api:' + device.id,peer ? 6000 : 600);
    if (route === '/v1/peers/index' && method === 'GET') {
      if (!peer) throw new HttpError(403,'Only linked servers can read the shared index');
      const index = shareIndex();
      if (req.headers['if-none-match'] === index.etag) { res.writeHead(304,{ETag:index.etag,'Cache-Control':'no-store'}); return res.end(); }
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Encoding':'gzip','Content-Length':index.body.length,ETag:index.etag,'Cache-Control':'no-store'});
      return res.end(index.body);
    }
    if (route === '/v1/peers/leave' && method === 'POST') { if (!peer) throw new HttpError(403,'Not a linked server'); leavePeer(device); return json(res,200,{ok:true}); }
    if (route === '/v1/radio/likes' && method === 'GET') { const devices = profileDevices(device.id); return json(res,200,{items:db.prepare(`SELECT song_id AS songId,title,artist,album,max(liked_at) AS likedAt FROM radio_likes WHERE device_id IN (${marks(devices)}) GROUP BY song_id ORDER BY likedAt DESC LIMIT 500`).all(...devices)}); }
    if (route === '/v1/radio/likes' && ['PUT','DELETE'].includes(method)) {
      limit('radio-likes:' + device.id,60);
      const input = await body(req);
      if (typeof input.songId !== 'string' || !/^rp:[1-9][0-9]{0,15}$/.test(input.songId)) throw new HttpError(400,'Invalid radio song');
      if (method === 'DELETE') { const devices = profileDevices(device.id); db.prepare(`DELETE FROM radio_likes WHERE device_id IN (${marks(devices)}) AND song_id=?`).run(...devices,input.songId); }
      else {
        for (const field of ['title','artist','album']) if (typeof input[field] !== 'string' || input[field].length > 500 || /[\x00-\x1f]/.test(input[field]) || (field !== 'album' && !input[field].trim())) throw new HttpError(400,'Invalid radio metadata');
        db.prepare('INSERT INTO radio_likes VALUES (?,?,?,?,?,?) ON CONFLICT(device_id,song_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,liked_at=excluded.liked_at').run(device.id,input.songId,input.title.trim(),input.artist.trim(),input.album.trim(),Date.now());
        db.prepare('DELETE FROM radio_likes WHERE device_id=? AND song_id NOT IN (SELECT song_id FROM radio_likes WHERE device_id=? ORDER BY liked_at DESC LIMIT 500)').run(device.id,device.id);
      }
      invalidateDiscovery(device.id);
      return json(res,200,{ok:true});
    }
    const administration = await appAdmin(route,method,device,() => body(req));
    if (administration) return json(res,200,administration);
    if (method === 'POST' && route === '/v1/device/profile') { updateDeviceNickname(device,await body(req)); return json(res,200,{ok:true}); }
    if (method === 'POST' && route === '/v1/connect/link') return json(res,200,createLink(device));
    if (method === 'POST' && route === '/v1/connect/join') return json(res,200,joinLink(device,await body(req)));
    if (method === 'POST' && route === '/v1/connect/discoverable') return json(res,200,setDiscoverable(device,await body(req)));
    if (method === 'POST' && route === '/v1/connect/pair') return json(res,200,requestPair(device,await body(req)));
    if (method === 'POST' && route === '/v1/connect/pair-decide') return json(res,200,decidePair(device,await body(req)));
    if (method === 'POST' && route === '/v1/connect/unpair') return json(res,200,unpair(device,await body(req)));
    if (method === 'POST' && route === '/v1/connect/pulse') { const input=await body(req); updateDeviceNickname(device,input); return json(res,200,{...pulse(device,input),lanBase:lanServerBase()}); }
    if (method === 'POST' && route === '/v1/connect/command') return json(res,200,sendCommand(device,await body(req)));
    if (method === 'GET' && route === '/v1/renderers') return json(res,200,listRenderers(url.searchParams.get('queue'),device.id));
    if (method === 'POST' && route === '/v1/renderers') { limit('renderer-add:' + device.id,20); return json(res,200,await addRenderer(await body(req),streamBase(req),device.id)); }
    if (method === 'GET' && route === '/v1/renderers/discover') { limit('renderer-discover:' + device.id,20); return json(res,200,await discoverRenderers(String(req.headers.host || '').replace(/:\d+$/,''),device.id)); }
    if (method === 'POST' && route === '/v1/renderers/stream') return json(res,200,await externalItem(device,await body(req),publicBase(req)));
    const renderer = route.match(/^\/v1\/renderers\/([a-f0-9-]{36})(?:\/(play|command))?$/);
    if (renderer && method === 'DELETE' && !renderer[2]) return json(res,200,await removeRenderer(renderer[1],device.id));
    if (renderer && method === 'POST' && renderer[2] === 'play') return json(res,200,await playOnRenderer(device,renderer[1],await body(req),streamBase(req)));
    if (renderer && method === 'POST' && renderer[2] === 'command') return json(res,200,await controlRenderer(device,renderer[1],await body(req)));
    if (method === 'GET' && /^\/v1\/tracks\/[a-f0-9]{64}$/.test(route)) {
      const track=getTrack(route.split('/').pop()); if(!track) throw Object.assign(new HttpError(404,'Track not found'),{code:'track_not_found'});
      return json(res,200,trackView(track,favorites(device.id)));
    }
    if (method === 'POST' && route === '/v1/auth/logout') {
      const token = req.headers.authorization.slice(7); db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token)); return json(res,200,{ok:true});
    }
    if (method === 'GET' && route === '/v1/library/status') return json(res,200,scanStatus);
    if (method === 'POST' && route === '/v1/library/rescan') { void scanLibrary(); return json(res,202,{ok:true}); }
    const favoriteIds = favorites(device.id);
    if (method === 'POST' && route === '/v1/discovery') {
      const input = await body(req, 65536);
      const genres = input.genreIds || [];
      if (!Array.isArray(genres) || genres.length > 256 || genres.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new HttpError(400,'Invalid genre selection');
      limit('discovery:' + device.id,30);
      return json(res,200,await discoverySeed(device,[...new Set(genres)]));
    }
    // format: a file type family (flac, dsd, mp3, alac, aac, pcm); echoed back
    // so the app can tell an older server that ignored it.
    const format = formatFamilies.includes(url.searchParams.get('format')) ? url.searchParams.get('format') : '';
    if (method === 'GET' && route === '/v1/albums') {
      // A genre family from the app lists several genre ids, one per line.
      const genreIds = (url.searchParams.get('genreId') || '').split('\n').filter(Boolean);
      const items = albumViews().filter(item => (!url.searchParams.get('artistId') || item.artistId === url.searchParams.get('artistId')) && (!genreIds.length || genreIds.some(id => item.genreIds.has(id))) && (!format || item.formats.some(value => formatFamily(value) === format)));
      return json(res,200,{ ...page(items,url.searchParams,favoriteIds), format });
    }
    if (method === 'GET' && ['/v1/artists','/v1/genres'].includes(route)) {
      const ids = format && idsWithFormat(route.slice(4), format);
      return json(res,200,{ ...page(groupViews(route.slice(4)).filter(item => !ids || ids.has(item.ref.itemId)),url.searchParams,favoriteIds), format });
    }
    if (method === 'GET' && route === '/v1/tracks' && !url.searchParams.get('albumId') && url.searchParams.get('layout') !== 'full')
      return json(res,200,page(trackViews(),url.searchParams,favoriteIds));
    if (method === 'GET' && route === '/v1/tracks') {
      let items = albumTracks(url.searchParams.get('albumId'),url.searchParams.get('layout')==='full'?'full':'chapters');
      if (url.searchParams.get('albumId')) items = items.filter(item => item.albumId === url.searchParams.get('albumId'));
      const views = items.map(item => trackView(item,favoriteIds));
      if (url.searchParams.get('albumId')) {
        views.sort((a,b) => a.disc - b.disc || a.number - b.number || a.title.localeCompare(b.title));
        const start = Math.max(0,Number(url.searchParams.get('startIndex')) || 0);
        return json(res,200,{items:views.slice(start,start+200),total:views.length});
      }
      return json(res,200,page(views,url.searchParams,favoriteIds));
    }
    if (method === 'GET' && route === '/v1/search') return json(res,200,{
      artists: page(groupViews('artists'),url.searchParams,favoriteIds),
      albums: page(albumViews(),url.searchParams,favoriteIds),
      tracks: page(trackViews(),url.searchParams,favoriteIds),
      genres: page(groupViews('genres'),url.searchParams,favoriteIds),
    });
    const resolve = route.match(/^\/v1\/tracks\/([a-f0-9]{64})\/resolve$/);
    if (method === 'POST' && resolve) {
      const track = getTrack(resolve[1]); if (!track) throw Object.assign(new HttpError(404,'Track not found'),{code:'track_not_found'});
      const delivery = await resolveDelivery(device,track,await body(req));
      return json(res,delivery.status,delivery.body);
    }
    const prepare = route.match(/^\/v1\/tracks\/([a-f0-9]{64})\/prepare$/);
    if(method==='POST' && prepare) {
      const track=getTrack(prepare[1]); if(!track) throw Object.assign(new HttpError(404,'Track not found'),{code:'track_not_found'});
      const ready=await prepareDelivery(track,await body(req));
      return json(res,ready.status,ready.body);
    }
    if (method === 'GET' && route === '/v1/playlists') return json(res,200,listPlaylists(device));
    if (method === 'POST' && route === '/v1/playlists') { limit('playlist-write:' + device.id,240); return json(res,200,createPlaylist(device,await body(req,524288))); }
    if (method === 'GET' && route === '/v1/profile') return json(res,200,profileView(device));
    if (method === 'PUT' && route === '/v1/profile') return json(res,200,renameProfile(device,await body(req)));
    if (method === 'POST' && route === '/v1/profile/link') return json(res,200,createProfileLink(device));
    if (method === 'POST' && route === '/v1/profile/join') { const view = joinProfile(device,await body(req)); invalidateDiscovery(device.id); return json(res,200,view); }
    if (method === 'POST' && route === '/v1/profile/leave') { const view = leaveProfile(device); invalidateDiscovery(device.id); return json(res,200,view); }
    const playlist = route.match(/^\/v1\/playlists\/([a-f0-9-]{36})(\/tracks|\/shares)?$/);
    if (playlist && method === 'GET' && !playlist[2]) return json(res,200,getPlaylist(device,playlist[1]));
    if (playlist && ['PUT','POST','DELETE'].includes(method)) limit('playlist-write:' + device.id,240);
    if (playlist && method === 'PUT' && !playlist[2]) return json(res,200,updatePlaylist(device,playlist[1],await body(req,524288)));
    if (playlist && method === 'PUT' && playlist[2] === '/shares') return json(res,200,sharePlaylist(device,playlist[1],await body(req)));
    if (playlist && method === 'POST' && playlist[2] === '/tracks') return json(res,200,addToPlaylist(device,playlist[1],await body(req,524288)));
    if (playlist && method === 'DELETE' && !playlist[2]) return json(res,200,deletePlaylist(device,playlist[1]));
    const favorite = route.match(/^\/v1\/favorites\/([a-f0-9]{64})$/);
    if (favorite && ['PUT','DELETE'].includes(method)) {
      const id = favorite[1];
      if (method === 'PUT') {
        if (!catalogHas(id)) throw new HttpError(404,'Item not found');
        db.prepare('INSERT OR IGNORE INTO favorites VALUES (?,?)').run(device.id,id);
      } else { const devices = profileDevices(device.id); db.prepare(`DELETE FROM favorites WHERE device_id IN (${marks(devices)}) AND item_id=?`).run(...devices,id); }
      return json(res,200,{ok:true});
    }
    if (['GET','HEAD'].includes(method) && image) return await artwork(req,res,url,image[1]);
    if (method === 'POST' && route === '/v1/playback') {
      const input = await body(req);
      recordPlayback(device,input);
      db.prepare('INSERT INTO progress VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET track_id=excluded.track_id,position=excluded.position,updated=excluded.updated').run(device.id,input.trackId,input.position,Date.now());
      return json(res,200,{ok:true});
    }
    throw new HttpError(404,'Endpoint not found');
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    if (!error.status) console.error('Request failed:',error.message);
    if (error.status === 429) res.setHeader('Retry-After','60');
    json(res,error.status || 500,{ error:error.status ? error.message : 'The server could not complete this request.', ...(error.status && error.code ? { code:error.code } : {}) });
  }
}
if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE');
const server = config.tlsCert ? https.createServer({ cert:readFileSync(config.tlsCert),key:readFileSync(config.tlsKey),minVersion:'TLSv1.2' },handler) : http.createServer(handler);
server.on('upgrade',(req,socket) => acceptSocket(req,socket,config.basePath));
server.maxConnections = 1024; server.maxHeadersCount = 32;
server.headersTimeout = 20000; server.requestTimeout = 30000; server.keepAliveTimeout = 65000;
server.listen(config.port,config.host,() => {
  console.log(`Sterio Server ${serverId} listening on ${config.tlsCert ? 'https' : 'http'}://${config.host}:${config.port}${config.basePath}`);
  console.log('Generate a pairing code: node src/cli.mjs pair');
  void migrateSplitFolders().catch(error => console.warn('Split folders:', error.message)).finally(() => scanLibrary());
});
const adminServer = startAdmin();
const scanTimer = setInterval(scanWhenDue,60000);
const pruneTimer = setInterval(() => void pruneCache().catch(error => console.warn('Cache cleanup:',error.message)),300000);
function shutdown(code = 0) { closeSockets(); adminServer?.close(); clearInterval(scanTimer); clearInterval(pruneTimer); server.close(() => { db.close(); process.exit(code); }); server.closeIdleConnections(); adminServer?.closeIdleConnections(); setTimeout(() => process.exit(code),10000).unref(); }
process.on('SIGTERM',() => shutdown()); process.on('SIGINT',() => shutdown());
// Sterio Server for Mac: a new music folder; the launcher starts the server again.
process.on('sterio-restart',() => shutdown(75));
