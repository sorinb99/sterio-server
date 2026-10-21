import { db, hash } from './db.mjs';
import { albumViews, favorites, groupViews, libraryRevision, mixTracks, scanStatus, trackView } from './library.mjs';
import { Worker } from 'node:worker_threads';
import { HttpError } from './auth.mjs';
import { marks, profileDevices, profileOf } from './profiles.mjs';

// Metadata only: never probe, resolve, convert or open audio while building Home.
const cache = new Map();
const flights = new Map();
let running = 0;
const DAY = 86400000;
// Home is built from the whole profile's listening: one cache per profile.
export function invalidateDiscovery(deviceId) { const profile = profileOf(deviceId); for (const key of cache.keys()) if (key.startsWith(profile + ':') || key.startsWith(deviceId + ':')) cache.delete(key); }
export async function discoverySeed(device, genreIds = []) {
  const key = profileOf(device.id) + ':' + [...genreIds].sort().join(',');
  const devices = profileDevices(device.id);
  const preference = db.prepare(`SELECT count(*) AS count,max(liked_at) AS latest FROM radio_likes WHERE device_id IN (${marks(devices)})`).get(...devices);
  const revision = `${scanStatus.lastFinished}:${libraryRevision()}:${preference.count}:${preference.latest}`;
  const saved = cache.get(key);
  if (saved && saved.revision === revision && Date.now() - saved.at < 600000) return saved.value;
  if (flights.has(key)) return flights.get(key);
  if (running >= 2) throw new HttpError(503,'Recommendations are busy. Your saved mixes are still available; try refreshing shortly.');
  running++;
  const flight = (async () => {
    const worker = new Worker(new URL('./discovery-worker.mjs', import.meta.url), {workerData: {device: {id: device.id}, genreIds}});
    let timeout;
    try {
      const value = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new HttpError(503,'Recommendations took too long. Please try again.')), 20000);
        worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.value));
        worker.once('error', reject);
        worker.once('exit', code => {if (code) reject(new Error('Recommendations worker stopped'));});
      });
      if (cache.size >= 64) cache.delete(cache.keys().next().value);
      cache.set(key, {at: Date.now(), revision, value});
      return value;
    } finally {clearTimeout(timeout); await worker.terminate();}
  })().finally(() => {running--; flights.delete(key);});
  flights.set(key, flight);
  return flight;
}

// Each short-lived worker reads fresh committed metadata in WAL mode. It cannot
// block the HTTP event loop, and has no access to the player's network requests.
export function buildDiscoverySeed(device, genreIds = []) {
  const ids = favorites(device.id);
  const devices = profileDevices(device.id), list = marks(devices);
  const radioLikes = db.prepare(`SELECT song_id AS songId,title,artist,album,max(liked_at) AS likedAt FROM radio_likes WHERE device_id IN (${list}) GROUP BY song_id ORDER BY likedAt DESC LIMIT 500`).all(...devices);
  const history = db.prepare(`SELECT track_id AS trackId, sum(listened) AS listened,
    sum(CASE WHEN listened >= min(30, duration * .35) AND listened > 0 THEN 1 ELSE 0 END) AS plays,
    max(last_seen) AS lastPlayed FROM playback_history
    WHERE device_id IN (${list}) AND started>? GROUP BY track_id ORDER BY lastPlayed DESC LIMIT 1000`).all(...devices, Date.now() - 180 * DAY);
  const last = db.prepare(`SELECT track_id, position FROM playback_history WHERE device_id IN (${list}) AND listened>2 ORDER BY last_seen DESC LIMIT 1`).get(...devices);
  const all = mixTracks();
  const byId = new Map(all.map(track => [track.id, track]));
  const artists = new Map(), genres = new Map();
  for (const h of history) {
    const t = byId.get(h.trackId);
    if (!t || !h.plays) continue;
    const weight = Math.min(5, h.plays) * Math.exp(-(Date.now() - h.lastPlayed) / (60 * DAY));
    artists.set(t.albumArtist, (artists.get(t.albumArtist) || 0) + weight);
    for (const g of t.genres || []) genres.set(g, (genres.get(g) || 0) + weight);
  }
  const catalogArtists = new Set(all.map(t => t.albumArtist || t.artist));
  for (const like of radioLikes) {
    const weight = 3 * Math.exp(-(Date.now() - like.likedAt) / (90 * DAY));
    // Match existing catalog spellings without changing catalog identity.
    for (const artist of catalogArtists) if (artist?.toLocaleLowerCase() === like.artist.toLocaleLowerCase()) artists.set(artist, (artists.get(artist) || 0) + weight);
  }
  const seed = device.id + ':' + Math.floor(Date.now() / DAY);
  const buckets = new Map();
  const wanted = new Set(genreIds);
  for (const t of all) {
    if (wanted.size && !(t.genreIds || []).some(id => wanted.has(id))) continue;
    const artist = t.albumArtist || t.artist;
    const score = (artists.get(artist) || 0) * .2 + Math.max(0, ...(t.genres || []).map(g => genres.get(g) || 0)) * .08
      + (ids.has(t.id) || ids.has(t.albumId) ? 1 : 0) + parseInt(hash(seed + t.id).slice(0, 8), 16) / 0xffffffff * 3;
    if (!buckets.has(artist)) buckets.set(artist, []);
    buckets.get(artist).push({t, score});
  }
  const pools = [...buckets.values()];
  for (const p of pools) p.sort((a, b) => b.score - a.score);
  pools.sort((a, b) => b[0].score - a[0].score);
  const candidates = [], seen = new Set();
  const add = t => { if (t && !seen.has(t.id)) { seen.add(t.id); candidates.push(t); } };
  // Include listened tracks so affinity survives even when the sampled catalog rotates.
  if (!wanted.size) for (const h of history.slice(0, 60)) add(byId.get(h.trackId));
  for (let round = 0; candidates.length < 360 && round < 16; round++) {
    let added = false;
    for (const p of pools) if (p[round]) { add(p[round].t); added = true; if (candidates.length >= 360) break; }
    if (!added) break;
  }
  const albums = albumViews();
  const albumMap = new Map(albums.map(a => [a.ref.itemId, a]));
  const recentIds = new Set();
  // rowid records first insertion, unlike mtime (which may predate the import).
  for (const row of db.prepare('SELECT metadata FROM tracks ORDER BY rowid DESC LIMIT 2000').all()) {
    const id = JSON.parse(row.metadata).albumId;
    if (albumMap.has(id)) recentIds.add(id);
    if (recentIds.size >= 12) break;
  }
  const albumView = a => { const {artistId, genreIds: _, ...visible} = a; return {...visible, favorite: ids.has(a.ref.itemId)}; };
  const visible = t => ({...trackView(t, ids), genres: t.genres || []});
  const resume = byId.get(last?.track_id);
  const value = {
    version: 1, generatedAt: Date.now(), tracks: candidates.map(visible), history, radioLikes,
    genres: groupViews('genres').map(g => ({...g, favorite: false})),
    recentAlbums: [...recentIds].map(id => albumView(albumMap.get(id))),
    resume: resume ? {track: visible(resume), position: last.position} : undefined,
  };
  return value;
}
