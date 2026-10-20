import http from 'node:http';
import https from 'node:https';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { config } from './config.mjs';
import { db, hash, getSetting, setSetting, serverId } from './db.mjs';
import { HttpError, parseKey, streamTicket } from './auth.mjs';
import { artworkPath, libraryChanged, libraryRevision, linkedArtist, linkedArtwork, linkedStats, sharedTracks } from './library.mjs';
import { storedArtwork } from './library-state.mjs';
import { directory as thumbnails, imageWidth } from './images.mjs';
// Linked servers. A server that shares its library generates a one-time key;
// the other server pairs with it exactly like an app does (a P-256 device key,
// a signed challenge for each session) and then reads its shared index. Apps
// connected to the linked server browse both libraries; audio and artwork of
// the other library stream through it, so apps never talk to the other server.
const keyPath = path.join(config.data, 'peer-key.pem');
try { writeFileSync(keyPath, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const privateKey = createPrivateKey(readFileSync(keyPath));
const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
const hex = /^[a-f0-9]{64}$/;
const text = (value, max = 512) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }) };

// ---- This server shares its library -------------------------------------
export function createShareKey() {
  const code = randomBytes(8).toString('hex'), expires = Date.now() + 10 * 60 * 1000;
  setSetting('peer.pairing', JSON.stringify({ hash: hash(code), expires }));
  return { code, expires };
}
export function pairPeer(input) {
  const invite = JSON.parse(getSetting('peer.pairing') || 'null');
  const codeHash = hash(String(input.code || '').trim().toLowerCase());
  if (!invite || invite.expires < Date.now() || !timingSafeEqual(Buffer.from(invite.hash, 'hex'), Buffer.from(codeHash, 'hex'))) throw new HttpError(403, 'Invalid or expired server key. Generate a new key on the server that shares its library.');
  if (typeof input.serverId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.serverId)) throw new HttpError(400, 'Invalid server identity');
  if (input.serverId === serverId) throw new HttpError(400, 'A server cannot link to itself');
  const parsed = parseKey(input.publicKey), name = text(input.name, 80) || 'Sterio server';
  db.exec('BEGIN IMMEDIATE');
  try {
    // The key is claimed atomically: it links one server, once.
    if (getSetting('peer.pairing') !== JSON.stringify(invite)) throw new HttpError(403, 'Server key already used');
    setSetting('peer.pairing', 'null');
    db.prepare('INSERT INTO devices VALUES (?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name, public_key=excluded.public_key, revoked=0').run(parsed.id, 'Server · ' + name, parsed.encoded, Date.now());
    db.prepare('INSERT INTO peer_clients VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET server_id=excluded.server_id, name=excluded.name').run(parsed.id, input.serverId, name, Date.now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log(`Linked server paired: "${name}" can now read this library`);
  return { keyId: parsed.id, serverId, name: config.name };
}
export const isPeerClient = deviceId => Boolean(db.prepare('SELECT 1 FROM peer_clients WHERE device_id=?').get(deviceId));
let shared = { revision: null };
// Built once per library revision; the ETag is a hash of the content, so a
// linked server that already has this exact index gets a 304.
export function shareIndex() {
  const revision = libraryRevision();
  if (shared.revision !== revision) {
    const tracks = sharedTracks(), value = JSON.stringify({ version: 1, serverId, name: config.name, tracks });
    shared = { revision, etag: '"' + hash(value).slice(0, 32) + '"', body: gzipSync(value), count: tracks.length };
  }
  return shared;
}
export function removePeerClient(deviceId) {
  if (typeof deviceId !== 'string' || !isPeerClient(deviceId)) throw new HttpError(400, 'Unknown linked server');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(deviceId);
    db.prepare('DELETE FROM sessions WHERE device_id=?').run(deviceId);
    db.prepare('DELETE FROM peer_clients WHERE device_id=?').run(deviceId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// ---- This server shows other servers' libraries ---------------------------
// pending: the code of a connection request the other server has not answered
// yet, or "declined".
try { db.exec("ALTER TABLE peers ADD COLUMN pending TEXT NOT NULL DEFAULT ''"); } catch {}
const peerRow = id => db.prepare('SELECT * FROM peers WHERE id=?').get(id);
// The addresses to try for what was typed: as written when it names http or
// https, otherwise HTTPS first and then HTTP, each also on 7766 without a port.
function baseUrls(input) {
  let value = String(input || '').trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!scheme) value = 'https://' + value;
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Enter the server address, for example 192.168.1.20 or music.example.com'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname) throw new HttpError(400, 'Enter an http or https server address without credentials');
  const base = u => u.origin + u.pathname.replace(/\/+$/, '').replace(/\/v1\/info$/, '');
  if (scheme) return [base(url)];
  const found = [];
  for (const protocol of ['https:', 'http:'])
    for (const port of url.port ? [url.port] : ['', '7766']) {
      const candidate = new URL(url); candidate.protocol = protocol; candidate.port = port;
      found.push(base(candidate));
    }
  return [...new Set(found)];
}
const sessions = new Map(), signIns = new Map();
async function send(peer, route, { method = 'GET', body, headers = {}, token, timeout = 15000 } = {}) {
  try {
    return await fetch(peer.url + route, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    throw new HttpError(502, error.name === 'TimeoutError' ? `${peer.name || peer.url} did not answer in time` : `Could not reach ${peer.name || peer.url}. Check the address.`);
  }
}
async function answer(response, peer) {
  const value = await response.json().catch(() => ({}));
  if (response.ok) return value;
  // Never pass the other server's 401 on: to an app, 401 means its own session expired.
  throw Object.assign(new HttpError(response.status === 404 ? 404 : 502, value.error ? `${peer.name || 'Linked server'}: ${value.error}` : `${peer.name || 'Linked server'} answered ${response.status}`), { code: value.code, remoteStatus: response.status });
}
function token(peer) {
  const saved = sessions.get(peer.id);
  if (saved && saved.expires > Date.now() + 60000) return Promise.resolve(saved.token);
  if (signIns.has(peer.id)) return signIns.get(peer.id);
  const job = (async () => {
    const challenge = await answer(await send(peer, '/v1/auth/challenge', { method: 'POST', body: { publicKey } }), peer);
    if (challenge.serverId !== peer.id || typeof challenge.message !== 'string') throw new HttpError(502, 'The linked server answered with a different identity');
    const signature = sign('sha256', Buffer.from(challenge.message), privateKey).toString('base64');
    const session = await answer(await send(peer, '/v1/auth/session', { method: 'POST', body: { id: challenge.id, signature } }), peer);
    sessions.set(peer.id, { token: session.accessToken, expires: session.expires });
    return session.accessToken;
  })().finally(() => signIns.delete(peer.id));
  signIns.set(peer.id, job);
  return job;
}
async function call(peer, route, options = {}) {
  let response = await send(peer, route, { ...options, token: await token(peer) });
  if (response.status === 401) { sessions.delete(peer.id); response = await send(peer, route, { ...options, token: await token(peer) }); }
  return response;
}
const tag = value => typeof value === 'string' && /^[\w.:-]{1,64}$/.test(value);
function cleanTrack(item) {
  if (!item || !hex.test(item.id) || !hex.test(item.albumId)) return null;
  const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max ? value : undefined;
  const format = item.format || {};
  const genres = (Array.isArray(item.genres) ? item.genres : []).map(name => text(name, 128)).filter(Boolean).slice(0, 32);
  const segment = item.segment && Number.isFinite(item.segment.startSeconds) && Number.isFinite(item.segment.endSeconds) && item.segment.endSeconds > item.segment.startSeconds ? { startSeconds: item.segment.startSeconds, endSeconds: item.segment.endSeconds } : null;
  const artist = text(item.artist) || 'Unknown artist';
  return { id: item.id, title: text(item.title) || 'Unknown title', artist, albumArtist: text(item.albumArtist) || artist, album: text(item.album) || 'Unknown album', albumId: item.albumId,
    genres: genres.length ? genres : ['Uncategorized'], durationMs: number(item.durationMs, 0, 7 * 86400000) || 0, number: number(item.number, 0, 9999) || 0, disc: number(item.disc, 1, 999) || 1, year: number(item.year, 0, 9999),
    format: { codec: text(format.codec, 32).toLowerCase() || 'unknown', container: text(format.container, 16).toLowerCase(), sampleRate: number(format.sampleRate, 1, 50000000), bitDepth: number(format.bitDepth, 1, 64), channels: number(format.channels, 1, 32) || 2 },
    dsd: item.dsd === true, ...(segment ? { segment } : {}), ...(tag(item.imageTag) ? { imageTag: item.imageTag } : {}), ...(tag(item.artistImageTag) ? { artistImageTag: item.artistImageTag } : {}) };
}
const syncing = new Map();
// force: fetch the whole index even when the other server reports no change.
export function syncPeer(id, { force = false } = {}) {
  if (syncing.has(id)) return syncing.get(id);
  const job = (async () => {
    const peer = peerRow(id);
    if (!peer) throw new HttpError(404, 'Linked server not found');
    if (peer.pending) return;
    const started = Date.now();
    try {
      const response = await call(peer, '/v1/peers/index', { headers: !force && peer.revision ? { 'If-None-Match': peer.revision } : {}, timeout: 120000 });
      if (response.status === 304) { db.prepare("UPDATE peers SET synced=?, error='' WHERE id=?").run(Date.now(), id); return; }
      const index = await answer(response, peer);
      if (index.serverId !== peer.id || !Array.isArray(index.tracks) || index.tracks.length > 1000000) throw new HttpError(502, 'The linked server sent an invalid library index');
      const tracks = index.tracks.map(cleanTrack).filter(Boolean), insert = db.prepare('INSERT OR REPLACE INTO peer_tracks VALUES (?,?,?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM peer_tracks WHERE peer_id=?').run(id);
        for (const track of tracks) insert.run(id, track.id, JSON.stringify(track));
        db.prepare("UPDATE peers SET name=?, revision=?, synced=?, error='' WHERE id=?").run(text(index.name, 80) || peer.name, response.headers.get('etag') || '', Date.now(), id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      libraryChanged();
      console.log(`Linked server "${peer.name}": ${tracks.length} tracks indexed in ${Date.now() - started} ms`);
    } catch (error) {
      const message = error.remoteStatus === 403 ? 'The other server removed this link. Connect again with a new server key.' : error.message;
      db.prepare('UPDATE peers SET error=? WHERE id=?').run(text(message, 300), id);
      console.warn(`Linked server "${peer.name}" sync failed: ${message}`);
      throw error;
    }
  })().finally(() => syncing.delete(id));
  syncing.set(id, job);
  return job;
}
export async function connectPeer(input) {
  const urls = baseUrls(input.url), code = String(input.code || '').trim().toLowerCase();
  if (code && !/^[a-f0-9]{16}$/.test(code)) throw new HttpError(400, 'Enter the 16-character server key generated on the other server, or leave it empty to send a connection request');
  // The first address where a Sterio server answers.
  let url, info, failure;
  for (const candidate of urls) {
    const probe = { id: '', url: candidate, name: '' };
    try {
      const value = await answer(await send(probe, '/v1/info', { timeout: urls.length > 1 ? 6000 : 10000 }), probe);
      if (value.provider === 'sterio' && typeof value.serverId === 'string') { url = candidate; info = value; break; }
      failure ??= new HttpError(502, 'That address is not a Sterio server');
    } catch (error) { failure ??= error; }
  }
  if (!url) throw failure;
  if (info.serverId === serverId) throw new HttpError(400, 'That address is this server');
  if (!info.peers) throw new HttpError(409, 'Update the other server to Sterio Server 0.1.28 or later first');
  const peer = { id: info.serverId, url, name: text(info.name, 80) || 'Sterio server' };
  if (!code) return requestPeer(peer, info);
  const paired = await answer(await send(peer, '/v1/peers/pair', { method: 'POST', body: { code, publicKey, serverId, name: config.name } }), peer);
  if (paired.serverId !== peer.id) throw new HttpError(502, 'The linked server answered with a different identity');
  db.prepare("INSERT INTO peers (id,url,name,created) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url, name=excluded.name, revision='', error=''").run(peer.id, url, peer.name, Date.now());
  sessions.delete(peer.id);
  console.log(`Linked server connected: "${peer.name}" at ${url}`);
  // The first index can take a while for a large library; the dashboard follows it.
  void syncPeer(peer.id).catch(() => {});
  return { ok: true };
}
// Without a server key: ask the other server to accept this one, then wait.
async function requestPeer(peer, info) {
  if (!info.accessRequests) throw new HttpError(409, `Update ${peer.name} to Sterio Server 0.1.44 or later, or connect with a server key generated there`);
  const value = await answer(await send(peer, '/v1/peers/request', { method: 'POST', body: { publicKey, serverId, name: config.name } }), peer);
  if (value.status === 'declined') throw new HttpError(403, `${peer.name} declined this connection. It can be asked again in a few minutes.`);
  const pending = value.status === 'approved' ? '' : String(value.code || '----');
  db.prepare("INSERT INTO peers (id,url,name,created,pending) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url, name=excluded.name, revision='', error='', pending=excluded.pending").run(peer.id, peer.url, peer.name, Date.now(), pending);
  sessions.delete(peer.id);
  console.log(pending ? `Connection request sent to "${peer.name}" at ${peer.url} (code ${pending})` : `Linked server connected: "${peer.name}" at ${peer.url}`);
  if (pending) awaitApproval(peer.id); else void syncPeer(peer.id).catch(() => {});
  return { ok: true, pending: !!pending };
}
const awaiting = new Set();
function awaitApproval(id) {
  if (awaiting.has(id)) return;
  awaiting.add(id);
  const started = Date.now();
  const tick = async () => {
    const peer = peerRow(id);
    if (!peer || !peer.pending || peer.pending === 'declined') { awaiting.delete(id); return; }
    try {
      const value = await answer(await send(peer, '/v1/peers/request', { method: 'POST', body: { publicKey, serverId, name: config.name }, timeout: 10000 }), peer);
      if (value.status === 'approved') {
        db.prepare("UPDATE peers SET pending='', error='' WHERE id=?").run(id);
        awaiting.delete(id);
        console.log(`Linked server "${peer.name}" accepted this server`);
        void syncPeer(id).catch(() => {});
        return;
      }
      if (value.status === 'declined') {
        db.prepare("UPDATE peers SET pending='declined', error=? WHERE id=?").run(`${peer.name} declined this connection.`, id);
        awaiting.delete(id);
        return;
      }
      db.prepare("UPDATE peers SET pending=?, error='' WHERE id=?").run(String(value.code || peer.pending), id);
    } catch (error) { db.prepare('UPDATE peers SET error=? WHERE id=?').run(text(error.message, 300), id); }
    // The other server keeps the request while this one keeps asking.
    setTimeout(tick, Date.now() - started < 10 * 60000 ? 4000 : 30000).unref();
  };
  void tick();
}
export async function removePeer(id) {
  const peer = peerRow(id);
  if (!peer) throw new HttpError(404, 'Linked server not found');
  // Best effort: the other server also forgets this server's key.
  await call(peer, '/v1/peers/leave', { method: 'POST', body: {}, timeout: 5000 }).catch(() => {});
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['peer_tracks', 'peer_media']) db.prepare(`DELETE FROM ${table} WHERE peer_id=?`).run(id);
    db.prepare('DELETE FROM peers WHERE id=?').run(id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  sessions.delete(id); libraryChanged();
  console.log(`Linked server removed: "${peer.name}"`);
}
export function leavePeer(device) {
  removePeerClient(device.id);
  console.log(`Linked server left: ${device.name}`);
}
export function peerSummary() {
  const stats = linkedStats(), empty = { tracks: 0, shown: 0, duplicates: 0, merged: 0 };
  return {
    connections: db.prepare('SELECT * FROM peers ORDER BY created').all().map(peer => ({ id: peer.id, name: peer.name, url: peer.url, synced: peer.synced, error: peer.error, syncing: syncing.has(peer.id), pending: peer.pending === 'declined' ? null : peer.pending || null, declined: peer.pending === 'declined', ...(stats.get(peer.id) || empty) })),
    clients: db.prepare('SELECT peer_clients.* FROM peer_clients JOIN devices ON devices.id=peer_clients.device_id WHERE devices.revoked=0 ORDER BY peer_clients.created').all().map(row => ({ deviceId: row.device_id, name: row.name, created: row.created })),
    sharedTracks: shareIndex().count,
  };
}
export function syncAll() {
  for (const { id, pending } of db.prepare('SELECT id, pending FROM peers').all()) {
    if (!pending) void syncPeer(id).catch(() => {});
    else if (pending !== 'declined') awaitApproval(id);
  }
  db.prepare('DELETE FROM peer_media WHERE expires<?').run(Date.now());
}

// ---- Playback and artwork through this server -----------------------------
const modes = { transcode: 'pcm', lossless: 'lossless', original: 'original' };
// The other server always sends its original (sourceOnly); this server, the
// one that serves the listener, decides about conversion and does it itself.
const sources = new Map();
export async function linkedSource(track, fresh = false) {
  const saved = sources.get(track.id);
  if (!fresh && saved && Date.now() - saved.at < 10 * 60000) return saved;
  const peer = peerRow(track.remote.peer);
  if (!peer) throw Object.assign(new HttpError(404, 'Track not found'), { code: 'track_not_found' });
  const value = await answer(await call(peer, `/v1/tracks/${track.remote.id}/resolve`, { method: 'POST', body: { delivery: 'original', sourceOnly: true } }), peer);
  if (typeof value.path !== 'string' || !value.path.startsWith('/') || !hex.test(value.mediaSourceId || '')) throw new HttpError(502, 'The linked server sent an invalid stream');
  if (sources.size > 2000) sources.clear();
  const source = { at: Date.now(), peer, value, url: new URL(value.path, peer.url).href };
  sources.set(track.id, source);
  return source;
}
// The first bytes of the original, to read a FLAC file's STREAMINFO.
export async function linkedHeader(source) {
  try {
    const response = await fetch(source.url, { headers: { Range: 'bytes=0-41' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    return response.ok ? Buffer.from(await response.arrayBuffer()).subarray(0, 42) : Buffer.alloc(0);
  } catch { return Buffer.alloc(0); }
}
// The local stream ID for a linked track. convert: the conversion this server
// does (pcm, lossless, cue); without it the original streams through.
export function rememberLinked(track, source, convert) {
  const mode = convert || (source.value.standaloneCue ? 'cue' : modes[source.value.mode] || 'original');
  const media = hash(`peer-media\0${source.peer.id}\0${convert === 'cue' ? track.remote.id : source.value.mediaSourceId}\0${mode}${convert ? '\0here' : ''}`);
  db.prepare('INSERT INTO peer_media VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET track_id=excluded.track_id, remote_id=excluded.remote_id, path=excluded.path, request=excluded.request, expires=excluded.expires')
    .run(media, source.peer.id, track.id, track.remote.id, source.value.path, JSON.stringify({ delivery: 'original', sourceOnly: true, ...(convert ? { convert } : {}) }), Date.now() + 25 * 60 * 60 * 1000);
  return { media, mode };
}
export const linkedMedia = id => db.prepare('SELECT * FROM peer_media WHERE id=? AND expires>?').get(id, Date.now());
// Byte ranges pass through unchanged, so seeking works as with a local file.
export async function proxyStream(req, res, media, retry = true) {
  const peer = peerRow(media.peer_id);
  if (!peer) throw new HttpError(404, 'This linked server was removed');
  const target = new URL(media.path, peer.url), headers = {};
  for (const name of ['range', 'if-range']) if (req.headers[name]) headers[name] = req.headers[name];
  const upstream = await new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers, agent: agents[target.protocol], timeout: 20000 }, resolve);
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new HttpError(502, `${peer.name} is unreachable`)));
    // A listener that stops early (skip, seek) ends the transfer upstream as well.
    res.once('close', () => { if (!res.writableFinished) request.destroy(); });
    request.end();
  });
  if ([401, 403].includes(upstream.statusCode) && retry) {
    // The other server's 24-hour stream ticket expired: ask for a fresh one.
    upstream.resume();
    const value = await answer(await call(peer, `/v1/tracks/${media.remote_id}/resolve`, { method: 'POST', body: JSON.parse(media.request) }), peer);
    if (typeof value.path !== 'string' || !value.path.startsWith('/')) throw new HttpError(502, 'The linked server sent an invalid stream');
    db.prepare('UPDATE peer_media SET path=? WHERE id=?').run(value.path, media.id);
    return proxyStream(req, res, { ...media, path: value.path }, false);
  }
  if (upstream.statusCode >= 400 && upstream.statusCode !== 416) { upstream.resume(); throw new HttpError(upstream.statusCode === 404 ? 404 : 502, `${peer.name} could not stream this track`); }
  const out = { 'Cache-Control': 'private, no-store' };
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (upstream.headers[name]) out[name] = upstream.headers[name];
  res.writeHead(upstream.statusCode, out);
  upstream.on('error', () => res.destroy());
  upstream.pipe(res);
}
const imageFlights = new Map(), missing = new Map();
// Artwork of linked items is fetched once per size and version and kept with
// the thumbnails (same disk limit and cleanup); refreshed after a day, or at
// once when the other server reports a new cover or photo.
async function fetchImage(id, source, requestedWidth, portrait = false) {
  const peer = peerRow(source.peer);
  if (!peer) return null;
  const width = imageWidth(requestedWidth);
  const file = path.join(thumbnails, `${id}-${hash(`peer-image:${source.peer}:${source.id}:${source.tag || ''}:${portrait}:${width}`).slice(0, 16)}.jpg`);
  const info = await stat(file).catch(() => null);
  if (info && Date.now() - info.mtimeMs < 86400000) return file;
  if ((missing.get(file) || 0) > Date.now()) return info ? file : null;
  if (imageFlights.has(file)) return imageFlights.get(file);
  const job = (async () => {
    try {
      const response = await call(peer, `/v1/images/${source.id}?width=${width}${portrait ? '&portrait=1' : ''}`, { timeout: 20000 });
      const data = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
      if (!data || data.length > 8 * 1024 * 1024 || data[0] !== 0xff || data[1] !== 0xd8) {
        if (missing.size >= 4096) missing.clear();
        missing.set(file, Date.now() + 600000); return info ? file : null;
      }
      const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp.jpg';
      try { await writeFile(temp, data); await rename(temp, file); } finally { await unlink(temp).catch(() => {}); }
      return file;
    } catch { return info ? file : null; }
  })().finally(() => imageFlights.delete(file));
  imageFlights.set(file, job);
  return job;
}
// undefined: not a linked item, use this library's artwork. Artwork chosen
// here (admin › Find artwork) wins over the other server's.
export async function linkedImage(id, requestedWidth) {
  if (storedArtwork(id)) return undefined;
  const source = linkedArtwork(id);
  return source ? fetchImage(id, source, requestedWidth) : undefined;
}
const photos = new Map();
// An artist this library has without a photo of its own shows the photo of a
// linked server that has one; otherwise the local album cover stays.
export async function linkedArtistPhoto(id, requestedWidth) {
  const source = linkedArtist(id);
  if (!source || storedArtwork(id)) return undefined;
  const key = id + ':' + source.tag, known = photos.get(key);
  if (known && known.until > Date.now() && !known.remote) return undefined;
  if (!known || known.until <= Date.now()) {
    const own = await artworkPath(id, { portraitOnly: true }).catch(() => null);
    if (photos.size >= 4096) photos.clear();
    photos.set(key, { until: Date.now() + 600000, remote: !own });
    if (own) return undefined;
  }
  return (await fetchImage(id, source, requestedWidth, true)) || undefined;
}
// For the artwork tools: whether a linked server already has artwork for this item.
export async function linkedHasArtwork(item) {
  if (item.kind === 'artist') {
    const source = linkedArtist(item.id);
    return Boolean(source && await fetchImage(item.id, source, 600, true));
  }
  return Boolean(await linkedImage(item.id, 600));
}
setTimeout(syncAll, 20000).unref();
setInterval(syncAll, 15 * 60 * 1000).unref();
