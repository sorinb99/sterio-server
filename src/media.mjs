import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stat, readdir, unlink, rename, statfs, utimes, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { cacheDir, musicPath, getTrack } from './library.mjs';
import { hash } from './db.mjs';
import { HttpError } from './auth.mjs';
import { load } from './load.mjs';
import { verbatimLayout, verbatimFrame, verbatimBlock, verbatimBits } from './verbatim.mjs';
const conversionErrors = new Map();
// Linked DSD → PCM conversions a streamer may play while they run: the
// original comes over the internet, so waiting for the whole file can take
// minutes. Keyed by the finished file's name.
const live = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Verbatim FLAC conversions apps play and seek while they run (verbatim.mjs).
// Keyed by the finished file's name.
const growing = new Map();
const pending = new Map(), activeFiles = new Set();
let active = 0; const waiting = [];
async function slot() {
  if (active >= config.workers) {
    if (waiting.length >= 64) throw new HttpError(503, 'Conversion queue is full. Try again shortly.');
    await new Promise(resolve => waiting.push(resolve));
  } else active++;
}
function release() { const next = waiting.shift(); if (next) next(); else active--; }
export function deliveredFormat(track) {
  const sourcePcm = track.dsd ? track.format.sampleRate / 8 : track.format.sampleRate;
  const family = sourcePcm % 44100 === 0 ? [44100,88200,176400,352800] : [48000,96000,192000,384000];
  const rate = [...family].reverse().find(value => value <= config.maxPcmRate && value <= sourcePcm) || 44100;
  return { codec: 'flac', container: 'flac', sampleRate: rate, bitDepth: 24, channels: Math.min(2, track.format.channels || 2) };
}
export function needsConversion(track) { return !track.dsd && !['mp3','flac','m4a','aac','alac','wav','aif','aiff'].includes(String(track.format.container).toLowerCase()); }
// Apple's FLAC decoder rejects very short frames (e.g. FFmpeg files using
// 16 samples per frame) even though independent FLAC decoders accept them.
// Inspect STREAMINFO, not encoder names; cache only for the same source version.
const flacCompatibility = new Map();
export async function needsLosslessRepack(track) {
  track = conversionSource(track);
  if (String(track.format.codec).toLowerCase() !== 'flac' || String(track.format.container).toLowerCase() !== 'flac') return false;
  const key = `${track.id}:${track.mtime}:${track.size}`;
  if (flacCompatibility.has(key)) return flacCompatibility.get(key);
  const file = await open(await musicPath(track.path), 'r');
  let required = false;
  try {
    const header = Buffer.alloc(42);
    const {bytesRead} = await file.read(header, 0, header.length, 0);
    required = shortFlacFrames(header.subarray(0, bytesRead));
  } finally { await file.close(); }
  if (flacCompatibility.size >= 10000) flacCompatibility.clear();
  flacCompatibility.set(key, required);
  return required;
}
// The first 42 bytes of a FLAC file: its STREAMINFO block.
export function shortFlacFrames(header) {
  if (header.length < 42 || header.toString('ascii',0,4) !== 'fLaC' || (header[4]&127) !== 0 || header.readUIntBE(5,3) !== 34) return false;
  const maxBlock = header.readUInt16BE(10);
  return maxBlock > 0 && maxBlock < 192;
}
// A CUE chapter streamed while it is cut from the album image (verbatim FLAC).
export const canStreamCue = track => canDeliverCueFlac(track) && !!verbatimBits(track.format.bitDepth || 16);
export const canDeliverCueFlac = track => !!track.segment && !!track.sourceId && !track.dsd && String(track.format.codec).toLowerCase() === 'flac' && String(track.format.container).toLowerCase() === 'flac';
const cacheName = (track, mode = 'pcm') => path.join(cacheDir, `${track.id}-${hash(`${track.mtime}:${track.size}:${mode === 'cue' ? `cue-flac-v1:${track.segment.startSeconds}:${track.segment.endSeconds}` : mode === 'cueverbatim' ? `cue-verbatim-v1:${track.segment.startSeconds}:${track.segment.endSeconds}` : mode === 'lossless' ? 'flac-4096-indexed-v2' : mode === 'verbatim' ? `${config.maxPcmRate}:flac-verbatim-v2` : `${config.maxPcmRate}:pcm-v4-flac4096-indexed`}`).slice(0,16)}.flac`);
// Existing complete PCM conversions can be reframed without re-running DSD
// conversion or resampling. The versioned destination keeps active URLs stable.
const legacyPcmCacheName = track => path.join(cacheDir, `${track.id}-${hash(`${track.mtime}:${track.size}:${config.maxPcmRate}:pcm-v2`).slice(0,16)}.flac`);
export async function pruneCache(protectedFile) {
  const files = [];
  for (const name of await readdir(cacheDir)) {
    if (!/^[a-f0-9]{64}-[a-f0-9]{16}\.(flac|jpg)$/.test(name)) continue;
    const file = path.join(cacheDir, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) files.push({ file, size: info.size, time: info.mtimeMs });
  }
  let bytes = files.reduce((sum,file) => sum + file.size, 0);
  files.sort((a,b) => a.time - b.time);
  // Oldest first: over the size limit, or not played for CACHE_MAX_DAYS.
  const stale = Date.now() - config.cacheDays * 86400000;
  for (const file of files) {
    if (bytes <= config.cacheBytes && file.time >= stale) break;
    if (file.file === protectedFile || activeFiles.has(file.file)) continue;
    await unlink(file.file).catch(() => {}); bytes -= file.size;
  }
}
// FFmpeg on a Mac does not find the system's trusted certificates on its own:
// the Mac app carries a copy (cacert.pem); Linux images use their system store.
const caFile = [fileURLToPath(new URL('../cacert.pem', import.meta.url)), '/etc/ssl/cert.pem'].find(file => existsSync(file));
// SoX resampling where FFmpeg has it (the Docker image); the FFmpeg in the Mac
// app has no libsoxr and uses its own resampler at a high-quality setting.
let resamplerFilter;
function resampler() {
  resamplerFilter ||= new Promise(resolve => {
    const child = spawn('ffmpeg', ['-hide_banner','-buildconf'], { stdio: ['ignore','pipe','ignore'] });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(text));
  }).then(text => text.includes('libsoxr') ? 'aresample=resampler=soxr:precision=28' : 'aresample=resampler=swr:filter_size=128:phase_shift=20:cutoff=0.97');
  return resamplerFilter;
}
const inputOptions = (source, sourceUrl) => sourceUrl ? ['-protocol_whitelist','file,http,https,tcp,tls,crypto','-reconnect','1','-reconnect_on_network_error','1','-reconnect_delay_max','10','-rw_timeout','30000000',...(source.startsWith('https:') && caFile ? ['-ca_file',caFile] : [])] : ['-protocol_whitelist','file'];
// sourceUrl: a linked server's original, read over HTTP by FFmpeg.
async function convert(track, destination, mode = 'pcm', sourceUrl) {
  const queued = Date.now(), name = track.path ? path.basename(track.path) : track.title;
  await slot();
  const started = Date.now();
  console.log(`Conversion start: ${mode} "${name}" waited ${started - queued} ms (active ${active}, queued ${waiting.length})`);
  const temp = destination + '.' + randomBytes(8).toString('hex') + '.part';
  try {
    const available = await statfs(cacheDir);
    if (available.bavail * available.bsize < 256 * 1024 * 1024) throw new HttpError(507, 'Not enough free space in the server data volume');
    let source = sourceUrl ? await sourceUrl() : await musicPath(track.path);
    let reframePcm = false;
    if (mode === 'pcm' && !sourceUrl) {
      const legacy = legacyPcmCacheName(track);
      reframePcm = await stat(legacy).then(info => info.isFile()).catch(() => false);
      if (reframePcm) source = legacy;
    }
    const format = deliveredFormat(track);
    const filter = await resampler();
    await new Promise((resolve,reject) => {
      // Extract CUE boundaries in samples. Accurate input seeking decodes from
      // the preceding FLAC frame; atrim fixes the exact output sample count.
      const rate = track.format.sampleRate;
      const startSample = mode === 'cue' ? Math.round(track.segment.startSeconds * rate) : 0;
      const samples = mode === 'cue' ? Math.round(track.segment.endSeconds * rate) - startSample : 0;
      const inputSeek = mode === 'cue' ? ['-ss', (startSample / rate).toFixed(9)] : [];
      const audioOptions = mode === 'cue'
        ? ['-t', (samples / rate).toFixed(9), '-af', `atrim=end_sample=${samples}`, '-c:a','flac','-compression_level','0','-frame_size','4096']
        : mode === 'lossless' || reframePcm
        ? ['-c:a','flac','-compression_level','5','-frame_size','4096']
        : ['-af',filter,'-ar',String(format.sampleRate),'-ac',String(format.channels),'-sample_fmt','s32','-c:a','flac','-compression_level','5','-frame_size','4096'];
      // A remote original survives short network drops; seeking uses byte ranges.
      const input = inputOptions(source, sourceUrl);
      const state = sourceUrl && mode === 'pcm' ? { temp, started: Date.now(), seconds: 0, done: false, failed: false } : null;
      const child = spawn('ffmpeg', ['-v','error','-nostdin','-y',...(state ? ['-progress','pipe:1'] : []),...input,...inputSeek,'-i',source,'-map','0:a:0','-map_metadata','-1','-vn','-sn','-dn',...audioOptions,'-f','flac',temp], { stdio: ['ignore',state ? 'pipe' : 'ignore','pipe'] });
      if (state) {
        live.set(destination, state);
        // How much audio is written, to judge whether playback can start now.
        child.stdout.on('data', chunk => { const match = String(chunk).match(/out_time_us=(\d+)(?![\s\S]*out_time_us=)/); if (match) state.seconds = Number(match[1]) / 1e6; });
        child.on('close', code => { if (code === 0) state.done = true; else state.failed = true; });
      }
      let errorText = '', tooLarge = false;
      // An original read over the internet can take longer than the track lasts.
      const timeout = setTimeout(() => child.kill('SIGKILL'), (sourceUrl ? 60 : 15) * 60 * 1000);
      const sizeTimer = setInterval(async () => {
        const info = await stat(temp).catch(() => null);
        if (info && info.size > config.cacheBytes) { tooLarge = true; child.kill('SIGKILL'); }
      }, 1000);
      // Stream tickets in a remote URL stay out of the log.
      child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).replace(/ticket=[^\s&"']+/g,'ticket=…').slice(-1000); });
      const clear = () => { clearTimeout(timeout); clearInterval(sizeTimer); };
      child.on('error', error => { clear(); reject(error); });
      child.on('close', code => {
        clear();
        if (code === 0) resolve();
        else { console.warn(`Audio conversion failed after ${Date.now() - started} ms: ${mode} "${name}"`, errorText); reject(new HttpError(tooLarge ? 413 : 422, tooLarge ? 'Converted track exceeds CACHE_MAX_MB. Increase the cache limit.' : 'Audio conversion failed. Check the server log and file codec.')); }
      });
    });
    const encoded = Date.now();
    // Apple HTTP FLAC seeking can report premature EOF without a SEEKTABLE,
    // even with standard audio blocks. Index the complete temporary file before
    // publishing it; this changes metadata only, never decoded audio samples.
    await new Promise((resolve, reject) => {
      const child = spawn('metaflac', ['--add-seekpoint=1s', temp], { stdio: ['ignore','ignore','pipe'] });
      let errorText = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
      child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-1000); });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else { console.warn('FLAC seek indexing failed:', errorText); reject(new HttpError(422, 'Could not prepare the FLAC seek index.')); }
      });
    });
    // Publish only complete conversions, so native players can seek using byte ranges.
    await rename(temp, destination);
    const size = (await stat(destination)).size;
    console.log(`Conversion done: ${mode} "${name}" encode ${encoded - started} ms, index ${Date.now() - encoded} ms, ${(size / 1048576).toFixed(1)} MB`);
    await pruneCache(destination);
    return destination;
  } finally {
    // A streamer still reading the live file keeps its open handle.
    const state = live.get(destination);
    if (state?.temp === temp) { if (!state.done) state.failed = true; live.delete(destination); }
    await unlink(temp).catch(() => {}); release();
  }
}
// The PCM length must be known before converting: a local DSF states its
// exact sample count; other sources use the probed duration. FFmpeg's output
// is padded or trimmed to exactly this length.
async function verbatimSamples(track, rate, file) {
  if (file && /\.dsf$/i.test(file)) {
    const handle = await open(file, 'r');
    try {
      const head = Buffer.alloc(72);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      if (bytesRead === head.length && head.toString('ascii',0,4) === 'DSD ' && head.toString('ascii',28,32) === 'fmt ') {
        const dsdRate = head.readUInt32LE(56), count = Number(head.readBigUInt64LE(64));
        if (dsdRate > 0 && count > 0) return Math.round(count * rate / dsdRate);
      }
    } finally { await handle.close(); }
  }
  return Math.round((track.durationMs || 0) / 1000 * rate);
}
const notify = state => { for (const wake of state.waiters) wake(); state.waiters.clear(); };
const changed = (state, ms) => new Promise(resolve => { const timer = setTimeout(resolve, ms); state.waiters.add(() => { clearTimeout(timer); resolve(); }); });
// DSD → PCM ('verbatim') or a CUE chapter cut from its image ('cueverbatim'),
// written as verbatim FLAC frames in their final place, so the file can be
// streamed and seeked from its first second.
async function convertVerbatim(track, destination, sourceUrl, mode = 'verbatim') {
  const queued = Date.now(), name = track.path ? path.basename(track.path) : track.title;
  await slot();
  const started = Date.now();
  console.log(`Conversion start: ${mode} "${name}" waited ${started - queued} ms (active ${active}, queued ${waiting.length})`);
  const temp = destination + '.' + randomBytes(8).toString('hex') + '.part';
  const state = { temp, layout: null, written: 0, seconds: 0, done: false, failed: false, waiters: new Set() };
  let handle;
  try {
    const source = sourceUrl ? await sourceUrl() : await musicPath(track.path);
    let rate, channels, bits, samples, seek = [], length = [], filter;
    if (mode === 'cueverbatim') {
      // The same sample boundaries as the compressed chapter (see convert).
      rate = track.format.sampleRate; channels = track.format.channels || 2; bits = verbatimBits(track.format.bitDepth || 16);
      const startSample = Math.round(track.segment.startSeconds * rate);
      samples = Math.round(track.segment.endSeconds * rate) - startSample;
      seek = ['-ss', (startSample / rate).toFixed(9)]; length = ['-t', (samples / rate).toFixed(9)];
      filter = `atrim=end_sample=${samples},apad=whole_len=${samples}`;
    } else {
      const format = deliveredFormat(track);
      rate = format.sampleRate; channels = format.channels; bits = 24;
      samples = await verbatimSamples(track, rate, sourceUrl ? null : source);
      filter = `${await resampler()}:osr=${rate},aformat=sample_fmts=s32:channel_layouts=${channels === 1 ? 'mono' : 'stereo'},apad=whole_len=${samples},atrim=end_sample=${samples}`;
    }
    if (!(samples > 0) || !bits) throw new HttpError(422, 'The track length is unknown, so it cannot be converted while playing.');
    const layout = verbatimLayout({ sampleRate: rate, channels, samples, bits });
    if (layout.size > config.cacheBytes) throw new HttpError(413, 'Converted track exceeds CACHE_MAX_MB. Increase the cache limit.');
    const available = await statfs(cacheDir);
    if (available.bavail * available.bsize < layout.size + 256 * 1024 * 1024) throw new HttpError(507, 'Not enough free space in the server data volume');
    handle = await open(temp, 'w');
    await handle.write(layout.header, 0, layout.header.length, 0);
    state.layout = layout; state.written = layout.header.length;
    growing.set(destination, state);
    const raw = bits === 16 ? 's16le' : 's24le';
    const child = spawn('ffmpeg', ['-v','error','-nostdin',...inputOptions(source, sourceUrl),...seek,'-i',source,...length,'-map','0:a:0','-vn','-sn','-dn','-af',filter,'-c:a',`pcm_${raw}`,'-f',raw,'pipe:1'], { stdio: ['ignore','pipe','pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).replace(/ticket=[^\s&"']+/g,'ticket=…').slice(-1000); });
    const exit = new Promise(resolve => { child.on('close', resolve); child.on('error', () => resolve(-1)); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), (sourceUrl ? 60 : 15) * 60 * 1000);
    let index = 0, rest = Buffer.alloc(0);
    const frameInput = index => layout.frameSamples(index) * channels * layout.bytes;
    const write = async data => {
      const frame = verbatimFrame(layout, index, data);
      await handle.write(frame, 0, frame.length, layout.offsets[index]);
      index++; state.written = layout.offsets[index];
      state.seconds = Math.min(samples, index * verbatimBlock) / rate;
      notify(state);
    };
    try {
      for await (const chunk of child.stdout) {
        rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let at = 0;
        for (let size; index < layout.frames && rest.length - at >= (size = frameInput(index)); at += size) await write(rest.subarray(at, at + size));
        rest = rest.subarray(at);
      }
    } finally { clearTimeout(timeout); }
    const code = await exit;
    if (code !== 0) {
      console.warn(`Audio conversion failed after ${Date.now() - started} ms: ${mode} "${name}"`, errorText);
      throw new HttpError(422, 'Audio conversion failed. Check the server log and file codec.');
    }
    // The length is fixed in the header: silence covers any shortfall.
    while (index < layout.frames) await write(Buffer.alloc(frameInput(index)));
    await handle.close(); handle = null;
    await rename(temp, destination);
    state.done = true; notify(state);
    console.log(`Conversion done: ${mode} "${name}" ${Date.now() - started} ms, ${(layout.size / 1048576).toFixed(1)} MB`);
    await pruneCache(destination);
    return destination;
  } finally {
    if (!state.done) { state.failed = true; notify(state); }
    if (growing.get(destination) === state) growing.delete(destination);
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {}); release();
  }
}
// Ready once a couple of seconds exist: conversion runs far ahead of playback,
// and the stream waits for any byte not yet written.
async function prepareGrowing(destination, start, waitMs) {
  if (await prepareJob(destination, start, 0)) return true;
  const until = Date.now() + waitMs;
  for (;;) {
    const state = growing.get(destination), work = pending.get(destination);
    if (state && !state.failed && (state.done || state.seconds >= 2)) return true;
    if (!work) {
      try { await stat(destination); return true; } catch {}
      const failed = conversionErrors.get(destination);
      if (failed) throw failed.error;
      return false;
    }
    if (Date.now() >= until) return false;
    await Promise.race([work.then(() => {}, () => {}), sleep(100)]);
  }
}
async function streamVerbatim(req, res, destination, start) {
  try { await stat(destination); await utimes(destination,new Date(),new Date()); return sendFile(req, res, destination, 'audio/flac'); } catch {}
  await prepareJob(destination, start, 0);
  for (;;) {
    const state = growing.get(destination), work = pending.get(destination);
    if (state && !state.failed) return streamGrowing(req, res, state, destination);
    if (!work) break;
    await Promise.race([work.then(() => {}, () => {}), sleep(50)]);
  }
  const failed = conversionErrors.get(destination);
  if (failed) throw failed.error;
  return sendFile(req, res, destination, 'audio/flac');
}
// Byte ranges of a file whose final size is known; bytes not converted yet
// are sent as soon as they are written.
async function streamGrowing(req, res, state, destination) {
  const size = state.layout.size;
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (match && (match[1] || match[2])) {
      if (match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
      else start = Math.max(0, size - Number(match[2]));
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    end = Math.min(end, size - 1); status = 206;
  }
  res.writeHead(status, { 'Content-Type': 'audio/flac', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Length': end - start + 1, ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD') { res.end(); return; }
  // Renamed to the finished file name once complete; either holds the same bytes.
  const handle = await open(state.temp, 'r').catch(() => open(destination, 'r'));
  load.stream(1);
  let closed = false, position = start;
  res.once('close', () => { closed = true; notify(state); });
  try {
    const buffer = Buffer.alloc(256 * 1024);
    while (!closed && position <= end) {
      const available = Math.min(end + 1, state.done ? size : state.written);
      if (position < available) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, available - position), position);
        if (!bytesRead) { res.destroy(); return; }
        position += bytesRead;
        if (!res.write(Buffer.from(buffer.subarray(0, bytesRead)))) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
        continue;
      }
      if (state.failed) { res.destroy(); return; }
      await changed(state, 1000);
    }
    res.end();
  } finally { load.stream(-1); await handle.close().catch(() => {}); }
}
export function conversionSource(track) { return track.sourceId ? getTrack(track.sourceId) : track; }
// waitMs lets /prepare answer as soon as a short job finishes, instead of the
// client discovering it on its next one-second poll.
export async function prepareConversion(track, mode = 'pcm', waitMs = 0) {
  if ((mode === 'cue' || mode === 'cueverbatim') && !canDeliverCueFlac(track)) throw new HttpError(422, 'This track is not a FLAC CUE chapter');
  if (mode !== 'cue' && mode !== 'cueverbatim') track=conversionSource(track);
  if (mode === 'verbatim' || mode === 'cueverbatim') return prepareGrowing(cacheName(track, mode), () => convertVerbatim(track, cacheName(track, mode), undefined, mode), waitMs);
  return prepareJob(cacheName(track, mode), () => convert(track,cacheName(track, mode),mode), waitMs);
}
async function prepareJob(destination, start, waitMs) {
  try { await stat(destination); return true; } catch {}
  const failed=conversionErrors.get(destination);
  if(failed && Date.now()-failed.time<60000) throw failed.error;
  conversionErrors.delete(destination);
  if(!pending.has(destination)) {
    const job=start().catch(error=> { conversionErrors.set(destination,{error,time:Date.now()}); throw error; }).finally(()=>pending.delete(destination));
    pending.set(destination,job); job.catch(()=>{});
  }
  if (!waitMs) return false;
  let timer;
  try { return await Promise.race([pending.get(destination).then(() => true), new Promise(resolve => { timer = setTimeout(resolve, waitMs, false); })]); }
  finally { clearTimeout(timer); }
}
export async function playablePath(track, mode) {
  if (mode === 'original') return musicPath(track.path);
  if (mode === 'cue' && !canDeliverCueFlac(track)) throw new HttpError(422, 'This track is not a FLAC CUE chapter');
  if (mode !== 'cue') track=conversionSource(track);
  const destination = cacheName(track, mode);
  try { await stat(destination); await utimes(destination,new Date(),new Date()); return destination; } catch {}
  if (!pending.has(destination)) pending.set(destination, convert(track, destination, mode).finally(() => pending.delete(destination)));
  return pending.get(destination);
}
// Tracks of a linked server: the server that serves the listener converts,
// reading the other server's original. media is the local stream ID.
const linkedCacheName = (media, track, mode) => path.join(cacheDir, `${media}-${hash(`linked:${track.format.sampleRate}:${track.format.codec}:${mode === 'cue' ? `cue-flac-v1:${track.durationMs}:${track.segment.startSeconds}:${track.segment.endSeconds}` : mode === 'cueverbatim' ? `cue-verbatim-v1:${track.durationMs}:${track.segment.startSeconds}:${track.segment.endSeconds}` : mode === 'lossless' ? 'flac-4096-indexed-v2' : mode === 'verbatim' ? `${config.maxPcmRate}:flac-verbatim-v2` : `${config.maxPcmRate}:pcm-v4-flac4096-indexed`}`).slice(0,16)}.flac`);
// A live conversion is far enough ahead once it has a buffer and runs
// clearly faster than playback; otherwise the streamer would stall.
function liveReady(destination) {
  const state = live.get(destination);
  if (!state || state.failed) return false;
  if (state.done) return true;
  const elapsed = (Date.now() - state.started) / 1000;
  return state.seconds >= 15 && state.seconds / Math.max(1, elapsed) >= 1.25;
}
// liveOk: streamers only. Apps wait for the finished file, which they can seek.
export async function prepareLinkedConversion(media, track, mode, sourceUrl, waitMs = 0, liveOk = false) {
  const destination = linkedCacheName(media, track, mode);
  if (mode === 'verbatim' || mode === 'cueverbatim') return prepareGrowing(destination, () => convertVerbatim(track, destination, sourceUrl, mode), waitMs);
  const ready = await prepareJob(destination, () => convert(track, destination, mode, sourceUrl), liveOk ? Math.min(waitMs, 2000) : waitMs);
  return ready || (liveOk && liveReady(destination));
}
export async function streamLinkedConversion(req, res, media, track, mode, sourceUrl) {
  const destination = linkedCacheName(media, track, mode);
  if (mode === 'verbatim' || mode === 'cueverbatim') return streamVerbatim(req, res, destination, () => convertVerbatim(track, destination, sourceUrl, mode));
  try { await stat(destination); await utimes(destination,new Date(),new Date()); }
  catch {
    if (!pending.has(destination)) pending.set(destination, convert(track, destination, mode, sourceUrl).finally(() => pending.delete(destination)));
    // From the start, while converting: the streamer plays as the file grows.
    const state = live.get(destination), range = req.headers.range;
    if (state && !state.failed && (!range || /^bytes=0-$/.test(range))) return streamLive(req, res, state);
    await pending.get(destination);
  }
  return sendFile(req, res, destination, 'audio/flac');
}
async function streamLive(req, res, state) {
  const handle = await open(state.temp, 'r');
  res.writeHead(200, { 'Content-Type': 'audio/flac', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'none' });
  if (req.method === 'HEAD') { await handle.close(); res.end(); return; }
  load.stream(1);
  let closed = false, position = 0;
  res.once('close', () => { closed = true; });
  try {
    const buffer = Buffer.alloc(256 * 1024);
    while (!closed) {
      // Checked before reading, so the last bytes are never skipped.
      const finished = state.done;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead) {
        position += bytesRead;
        if (!res.write(Buffer.from(buffer.subarray(0, bytesRead)))) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
        continue;
      }
      if (state.failed) { res.destroy(); return; }
      if (finished) break;
      await sleep(250);
    }
    res.end();
  } finally { load.stream(-1); await handle.close().catch(() => {}); }
}
const contentTypes = { '.mp3':'audio/mpeg','.flac':'audio/flac','.m4a':'audio/mp4','.alac':'audio/mp4','.aac':'audio/aac','.wav':'audio/wav','.aif':'audio/aiff','.aiff':'audio/aiff','.dsf':'audio/x-dsf','.dff':'audio/x-dff','.dsdiff':'audio/x-dff','.jpg':'image/jpeg' };
export async function sendFile(req, res, filename, type) {
  activeFiles.add(filename);
  let info;
  try { info = await stat(filename); } catch (error) { activeFiles.delete(filename); throw new HttpError(404, 'Media file unavailable'); }
  const size = info.size;
  res.setHeader('Content-Type', type || contentTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  const etag='"'+hash(`${info.ino}:${size}:${info.mtimeMs}`).slice(0,32)+'"';
  res.setHeader('ETag',etag); res.setHeader('Last-Modified',info.mtime.toUTCString());
  let start = 0, end = size - 1, status = 200;
  const ifRange=req.headers['if-range'];
  const same=!ifRange || ifRange===etag || (!ifRange.startsWith('"') && Number.isFinite(Date.parse(ifRange)) && info.mtimeMs<Date.parse(ifRange)+1000);
  if (req.headers.range && same) {
    const match = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) { activeFiles.delete(filename); res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    if (match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
    else start = Math.max(0, size - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) { activeFiles.delete(filename); res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    end = Math.min(end, size - 1); status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', Math.max(0,end - start + 1)); res.writeHead(status);
  if (req.method === 'HEAD' || size === 0) { activeFiles.delete(filename); res.end(); return; }
  const stream = createReadStream(filename, { start, end });
  load.stream(1);
  let open = true;
  const done = () => { if (open) { open = false; load.stream(-1); } activeFiles.delete(filename); stream.destroy(); };
  res.once('close', done); res.once('finish', done);
  stream.on('error', () => res.destroy()); stream.pipe(res);
}
export async function streamTrack(req,res,id,mode) {
  const track = getTrack(id);
  if (!track) throw new HttpError(404, 'Track not found');
  if (mode === 'verbatim' || mode === 'cueverbatim') {
    if (mode === 'cueverbatim' && !canDeliverCueFlac(track)) throw new HttpError(422, 'This track is not a FLAC CUE chapter');
    const source = mode === 'verbatim' ? conversionSource(track) : track, destination = cacheName(source, mode);
    return streamVerbatim(req, res, destination, () => convertVerbatim(source, destination, undefined, mode));
  }
  const file = await playablePath(track, mode);
  return sendFile(req,res,file,mode !== 'original' ? 'audio/flac' : undefined);
}
