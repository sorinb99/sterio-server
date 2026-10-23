import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { hash } from './db.mjs';
import { albumViews, artworkPath, cacheDir, groupViews, libraryRevision, linkedArtwork, processFile, scanStatus } from './library.mjs';
import { artworkTag, canonicalArtist } from './library-state.mjs';
import { HttpError } from './auth.mjs';

export const directory = path.join(cacheDir, 'thumbnails-v1');
await mkdir(directory, {recursive: true});
const recent = new Map(), pending = new Map(), waiting = [], inUse = new Map();
let active = 0;
export function imageWidth(raw) {
  const value = Number(raw);
  const width = Number.isFinite(value) && value > 0 ? Math.min(2000, value) : 384;
  // 2000: the Mac app's full-size covers (an original smaller than that stays its size).
  return [128, 256, 384, 600, 1000, 2000].find(size => size >= width);
}
async function slot() {
  if (active >= 2) await new Promise(resolve => waiting.push(resolve));
  else active++;
}
function release() {const next = waiting.shift(); if (next) next(); else active--;}
function remember(key, value) {
  if (recent.size >= 2048) recent.delete(recent.keys().next().value);
  recent.set(key, value);
}
// portraitOnly: an artist's own photo, never an album cover in its place
// (linked servers ask for it to decide whose artist photo to show).
export async function thumbnailPath(id, requestedWidth, {portraitOnly = false} = {}) {
  const width = imageWidth(requestedWidth), canonical = canonicalArtist(id, '').id;
  const key = canonical + ':' + width + ':' + portraitOnly + ':' + artworkTag(canonical, 'front-v3') + ':' + libraryRevision();
  const saved = recent.get(key);
  if (saved && Date.now() - saved.at < 300000) {
    if (!saved.file) return null;
    try {await stat(saved.file); return saved.file;} catch {recent.delete(key);}
  }
  if (pending.has(key)) return pending.get(key);
  if (waiting.length >= 128) throw new HttpError(503, 'Artwork is busy; please retry shortly.');
  const job = (async () => {
    await slot();
    let temp;
    try {
      const original = await artworkPath(canonical, {portraitOnly});
      if (!original) {remember(key, {at: Date.now() - 240000, file: null}); return null;}
      const info = await stat(original);
      const file = path.join(directory, canonical + '-' + hash(`${original}:${info.size}:${info.mtimeMs}:${width}:jpeg-q-v1`).slice(0, 16) + '.jpg');
      try {await stat(file); remember(key, {at: Date.now(), file}); return file;} catch {}
      temp = file + '.' + randomBytes(6).toString('hex') + '.tmp.jpg';
      // Resize the existing cover, never the audio stream. No upscaling; retain
      // the front-cover crop and portrait proportions already chosen upstream.
      await processFile('ffmpeg', ['-v','error','-nostdin','-y','-threads','1','-protocol_whitelist','file','-i',original,
        '-vf',`scale=w='min(iw,${width})':h='min(ih,${width})':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`,
        '-frames:v','1','-threads','1','-q:v',width >= 2000 ? '2' : width >= 600 ? '3' : '5','-pix_fmt','yuvj420p','-f','image2',temp], 15000);
      await rename(temp, file); temp = undefined;
      remember(key, {at: Date.now(), file});
      return file;
    } finally {if (temp) await unlink(temp).catch(() => {}); release();}
  })().finally(() => pending.delete(key));
  pending.set(key, job); return job;
}

// This handler is called only after device authentication. Audio sendFile/Range
// handling and its no-store policy are deliberately untouched.
export async function sendImage(req, res, file) {
  inUse.set(file, (inUse.get(file) || 0) + 1);
  let stream, released = false;
  const done = () => {
    if (released) return; released = true;
    const count = (inUse.get(file) || 1) - 1;
    if (count) inUse.set(file, count); else inUse.delete(file);
    stream?.destroy();
  };
  res.once('close', done); res.once('finish', done);
  try {
    const info = await stat(file), etag = '"' + hash(`${path.basename(file)}:${info.size}:${info.mtimeMs}`).slice(0, 32) + '"';
    res.setHeader('Content-Type', 'image/jpeg');
    // Image URLs carry the artwork tag (?v=), so a changed cover gets a new URL.
    // No Vary on Authorization: app tokens rotate every 30 minutes, and the
    // phone's cache must survive that instead of downloading every cover again.
    res.setHeader('Cache-Control', 'private, max-age=2592000');
    res.setHeader('ETag', etag); res.setHeader('Last-Modified', info.mtime.toUTCString());
    const condition = req.headers['if-none-match'];
    if (condition && condition.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag) ||
      !condition && req.headers['if-modified-since'] && info.mtimeMs < Date.parse(req.headers['if-modified-since']) + 1000) {
      res.writeHead(304); res.end(); return;
    }
    res.setHeader('Content-Length', info.size);
    res.writeHead(200);
    if (req.method === 'HEAD') {res.end(); return;}
    stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
  } catch (error) {done(); throw error;}
}

// Thumbnails have their own disk ceiling (1 GB, room for the Mac's full-size
// covers) and never evict or touch audio caches.
let pruning = false;
async function pruneThumbnails() {
  if (pruning) return;
  pruning = true;
  try {
    const entries = [];
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      if (name.endsWith('.tmp.jpg')) {if (Date.now() - info.mtimeMs > 3600000) await unlink(file).catch(() => {}); continue;}
      if (/^[a-f0-9]{64}-[a-f0-9]{16}\.jpg$/.test(name)) entries.push({file, size: info.size, at: info.mtimeMs});
    }
    let bytes = entries.reduce((total, entry) => total + entry.size, 0);
    entries.sort((a, b) => a.at - b.at);
    for (const entry of entries) {
      if (bytes <= 1024 * 1024 * 1024) break;
      if (inUse.has(entry.file) || Date.now() - entry.at < 3600000) continue;
      await unlink(entry.file).catch(() => {}); bytes -= entry.size;
    }
  } finally {pruning = false;}
}
setInterval(() => {void pruneThumbnails().catch(() => {});}, 600000).unref();

// After a scan that changed the library the covers apps show in lists and
// shelves are resized ahead of time, one at a time and only while no app is
// waiting for artwork, so a page opens with its images ready instead of
// waiting on ffmpeg. A scan that found nothing new leaves them be.
let warmedFor = null, warming = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function warmThumbnails() {
  if (warming || scanStatus.running || !scanStatus.lastFinished || warmedFor === libraryRevision()) return;
  warming = true; warmedFor = libraryRevision();
  const started = Date.now(); let made = 0;
  try {
    const jobs = [...albumViews().filter(album => !linkedArtwork(album.ref.itemId)).map(album => [album.ref.itemId, [256, 384]]), ...groupViews('artists').map(artist => [artist.ref.itemId, [128, 256]])];
    for (const [id, widths] of jobs) for (const width of widths) {
      while (active > 0 || waiting.length) await sleep(250);
      if (scanStatus.running) return;
      if (await thumbnailPath(id, width).catch(() => null)) made++;
    }
    console.log(`Artwork thumbnails ready: ${made} in ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {warming = false;}
}
setInterval(() => void warmThumbnails().catch(error => console.warn('Artwork warm-up:', error.message)), 30000).unref();
