// SACD disc images (.iso) played straight from the image: the disc's own
// tables give the album and its tracks, and each track is read from its
// sectors while it plays. Nothing is extracted or kept; the image is only
// read. Layout: Scarletbook, as documented by sacd-ripper (scarletbook.h).
// Stereo area only. Plain DSD streams as a DSF file made on the fly (exact
// size, byte ranges, seeking); DST-compressed areas go to FFmpeg's DST
// decoder as a DSDIFF file written for that conversion and removed after it.
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { load } from './load.mjs';

const SECTOR = 2048, FPS = 75, FRAME_BYTES = 4704, BLOCK = 4096, DSF_HEADER = 92, DSD_RATE = 2822400;
const charsets = ['latin1','shift_jis','latin1','shift_jis','euc-kr','gbk','big5','latin1'];
const frameCount = (m, s, f) => (m * 60 + s) * FPS + f;

async function sectors(handle, lsn, count) {
  const buffer = Buffer.alloc(count * SECTOR);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, lsn * SECTOR);
  return buffer.subarray(0, bytesRead - bytesRead % SECTOR);
}
function text(buffer, at, charset) {
  if (!at || at >= buffer.length) return '';
  let end = at; while (end < buffer.length && buffer[end]) end++;
  const bytes = buffer.subarray(at, end).map(byte => byte < 0x20 ? 0x20 : byte);
  let value;
  try { value = new TextDecoder(charset).decode(bytes); } catch { value = bytes.toString('latin1'); }
  return value.replace(/\s+/g, ' ').trim().slice(0, 512);
}

// The disc's tables: a few sectors, never the audio. Throws when the image is
// not a SACD (a DVD or data disc has no Master TOC at sector 510).
export async function readSacd(file) {
  const handle = await open(file, 'r');
  try {
    const master = await sectors(handle, 510, 2);
    if (master.length < 2 * SECTOR || master.toString('latin1', 0, 8) !== 'SACDMTOC') throw new Error('Not a SACD image');
    const charset = charsets[master[136 + 2] & 7];
    const mtext = master.subarray(SECTOR, 2 * SECTOR), named = mtext.toString('latin1', 0, 8) === 'SACDText';
    const field = at => named ? text(mtext, mtext.readUInt16BE(at), charset) : '';
    const info = {
      album: field(32) || field(16), artist: field(34) || field(18),
      year: master.readUInt16BE(120) || undefined,
      catalog: master.toString('latin1', 88, 104).replace(/\0/g, '').trim(),
      discs: master.readUInt16BE(16) || 1, disc: master.readUInt16BE(18) || 1,
      areas: [],
    };
    for (const [startAt, sizeAt] of [[64, 84], [72, 86]]) {
      const start = master.readUInt32BE(startAt), size = master.readUInt16BE(sizeAt);
      if (!start || !size || size > 64) continue;
      const area = await readArea(await sectors(handle, start, size), charset);
      if (area) info.areas.push(area);
    }
    if (!info.areas.length) throw new Error('No audio area');
    return info;
  } finally { await handle.close(); }
}
function readArea(data, discCharset) {
  const id = data.toString('latin1', 0, 8);
  if (id !== 'TWOCHTOC' && id !== 'MULCHTOC') return null;
  const channels = data[32], speakers = data[33] >> 3, format = data[21] & 15, count = data[69];
  const charset = data[80] ? charsets[data[88 + 2] & 7] : discCharset;
  const area = {
    kind: channels === 2 && speakers === 0 ? 'stereo' : 'multichannel', channels,
    dst: format === 0, rate: data[20] === 4 ? DSD_RATE : 0,
    start: data.readUInt32BE(72), end: data.readUInt32BE(76),
    frames: frameCount(data[64], data[65], data[66]), tracks: [],
  };
  if (!area.rate || !count) return null;
  let lsn = [], length = [], times = [], titles = [];
  for (let at = SECTOR; at + SECTOR <= data.length; at += SECTOR) {
    const tag = data.toString('latin1', at, at + 8);
    if (tag === 'SACDTRL1') for (let i = 0; i < count; i++) { lsn[i] = data.readUInt32BE(at + 8 + 4 * i); length[i] = data.readUInt32BE(at + 1028 + 4 * i); }
    else if (tag === 'SACDTRL2') for (let i = 0; i < count; i++) times[i] = [frameCount(data[at + 8 + 4 * i], data[at + 9 + 4 * i], data[at + 10 + 4 * i]), frameCount(data[at + 1028 + 4 * i], data[at + 1029 + 4 * i], data[at + 1030 + 4 * i])];
    else if (tag === 'SACDTTxt' && !titles.length) titles = trackText(data, at, count, charset);
  }
  if (lsn.length !== count || times.length !== count) return null;
  for (let i = 0; i < count; i++) {
    if (!times[i][1]) continue;
    area.tracks.push({ number: i + 1, title: titles[i]?.title || '', performer: titles[i]?.performer || '', lsn: lsn[i], length: length[i], start: times[i][0], frames: times[i][1] });
  }
  return area.tracks.length ? area : null;
}
// Per track: N items, each a type (1 title, 2 performer), a padding byte and
// a zero-terminated string, padded with zeros to the next item.
function trackText(data, at, count, charset) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const position = data.readUInt16BE(at + 8 + 2 * i);
    if (!position) continue;
    let p = at + position; const items = data[p], entry = {}; p += 4;
    for (let j = 0; j < items && p < data.length; j++) {
      const type = data[p]; p += 2;
      const value = text(data, p, charset);
      if (type === 1) entry.title = value; else if (type === 2) entry.performer = value;
      while (p < data.length && data[p]) p++;
      while (p < data.length && !data[p]) p++;
    }
    result[i] = entry;
  }
  return result;
}

// The library's tracks for an image: its stereo area, one album.
export function sacdTracks(relative, info, size, mtime, hash) {
  const area = info.areas.find(item => item.kind === 'stereo');
  if (!area) return [];
  const folder = path.dirname(relative), name = path.basename(relative, path.extname(relative));
  const album = info.album || name, albumArtist = info.artist || 'Unknown artist';
  const albumId = hash(`album\0${folder}\0${albumArtist}\0${album}`);
  return area.tracks.map(track => ({
    id: hash(`${relative}\0sacd\0${track.number}`), path: `${relative}#${track.number}`,
    title: track.title || `Track ${track.number}`, artist: track.performer || albumArtist, albumArtist, album, albumId,
    artistId: hash(`artist\0${albumArtist}`), genres: ['Uncategorized'], genreIds: [hash('genre\0Uncategorized')],
    durationMs: Math.round(track.frames / FPS * 1000), number: track.number, disc: info.disc, year: info.year,
    format: { codec: area.dst ? 'dst' : 'dsd', container: area.dst ? 'iso' : 'dsf', sampleRate: area.rate, bitDepth: 1, channels: area.channels, image: 'iso' },
    dsd: true,
    sacd: { image: relative, size, mtime, dst: area.dst, channels: area.channels, areaStart: area.start, areaEnd: area.end, lsn: track.lsn, length: track.length, start: track.start, frames: track.frames },
  }));
}

// Audio sectors: up to 7 packets; a frame starts in a packet marked so and
// continues in the next ones. Plain DSD frames are a fixed size; a DST frame
// is complete when its announced packet count has arrived.
async function* audioFrames(handle, s, fromLsn, toLsn) {
  let frame = null;
  const complete = () => frame && frame.size && (frame.dst ? frame.left <= 0 : frame.size === s.channels * FRAME_BYTES);
  for (let lsn = fromLsn; lsn < toLsn;) {
    const block = await sectors(handle, lsn, Math.min(64, toLsn - lsn));
    if (!block.length) break;
    lsn += block.length / SECTOR;
    for (let at = 0; at < block.length; at += SECTOR) {
      const head = block[at], packets = head >> 5, starts = (head >> 2) & 7, dst = head & 1;
      let p = at + 1;
      const info = [];
      for (let i = 0; i < packets; i++, p += 2) info.push({ start: block[p] >> 7, type: (block[p] >> 3) & 7, length: ((block[p] & 7) << 8) | block[p + 1] });
      const timecodes = [];
      for (let i = 0; i < starts; i++, p += dst ? 4 : 3) timecodes.push({ tc: frameCount(block[p], block[p + 1], block[p + 2]), left: dst ? (block[p + 3] >> 2) & 31 : 0 });
      let next = 0;
      for (const packet of info) {
        if (p + packet.length > at + SECTOR) { frame = null; break; }
        if (packet.type === 2) {
          if (packet.start) {
            if (complete()) yield { tc: frame.tc, data: Buffer.concat(frame.parts) };
            const meta = timecodes[next++] || { tc: -1, left: 0 };
            frame = { tc: meta.tc, left: meta.left, dst, size: 0, parts: [] };
          }
          if (frame) {
            frame.parts.push(block.subarray(p, p + packet.length)); frame.size += packet.length;
            if (frame.dst) frame.left--;
            if (frame.size > 65536) frame = null;
          }
        }
        p += packet.length;
      }
    }
  }
  if (complete()) yield { tc: frame.tc, data: Buffer.concat(frame.parts) };
}
// The track's frames in order from frame `first`: exactly as many as the
// track lasts; a frame the image lacks is null (the caller fills silence).
async function* trackFrames(handle, s, first = 0, fromLsn) {
  const end = s.start + s.frames, to = Math.min(s.areaEnd + 1, s.lsn + s.length + 64);
  let expected = s.start + first;
  for await (const frame of audioFrames(handle, s, fromLsn ?? Math.max(s.areaStart, s.lsn - 8), to)) {
    if (frame.tc < expected) continue;
    if (frame.tc >= end) break;
    while (expected < frame.tc) { yield null; expected++; }
    yield frame.data; expected++;
  }
  while (expected < end) { yield null; expected++; }
}
// The first frame starting in a sector at or after lsn, for seeking.
async function firstTimecode(handle, lsn, limit) {
  for (let n = 0; n < 16 && lsn + n < limit; n++) {
    const sector = await sectors(handle, lsn + n, 1);
    if (!sector.length) return null;
    const head = sector[0], packets = head >> 5, starts = (head >> 2) & 7;
    if (starts) { const p = 1 + packets * 2; return frameCount(sector[p], sector[p + 1], sector[p + 2]); }
  }
  return null;
}
async function seekSector(handle, s, first) {
  if (first <= 0) return undefined;
  const target = s.start + first;
  let lo = s.lsn, hi = s.lsn + s.length;
  while (hi - lo > 4) {
    const mid = (lo + hi) >> 1, tc = await firstTimecode(handle, mid, hi);
    if (tc === null || tc > target) hi = mid; else lo = mid;
  }
  return lo;
}

// Plain DSD as DSF: a 92-byte header, then per 4096-byte block of each
// channel in turn, bits least significant first. The size follows from the
// track's frame count, so byte ranges map straight to frames.
const reversed = Uint8Array.from({ length: 256 }, (_, n) => { let r = 0; for (let b = 0; b < 8; b++) r |= ((n >> b) & 1) << (7 - b); return r; });
const SILENCE = reversed[0x69];
const perChannel = s => s.frames * FRAME_BYTES;
export const sacdDsfSize = s => DSF_HEADER + Math.ceil(perChannel(s) / BLOCK) * BLOCK * s.channels;
function dsfHeader(s) {
  const header = Buffer.alloc(DSF_HEADER), data = Math.ceil(perChannel(s) / BLOCK) * BLOCK * s.channels;
  header.write('DSD ', 0, 'latin1'); header.writeBigUInt64LE(28n, 4); header.writeBigUInt64LE(BigInt(DSF_HEADER + data), 12); header.writeBigUInt64LE(0n, 20);
  header.write('fmt ', 28, 'latin1'); header.writeBigUInt64LE(52n, 32);
  header.writeUInt32LE(1, 40); header.writeUInt32LE(0, 44); header.writeUInt32LE(s.channels === 2 ? 2 : s.channels === 5 ? 6 : 7, 48);
  header.writeUInt32LE(s.channels, 52); header.writeUInt32LE(DSD_RATE, 56); header.writeUInt32LE(1, 60);
  header.writeBigUInt64LE(BigInt(perChannel(s) * 8), 64); header.writeUInt32LE(BLOCK, 72); header.writeUInt32LE(0, 76);
  header.write('data', 80, 'latin1'); header.writeBigUInt64LE(BigInt(12 + data), 84);
  return header;
}
// DSF bytes from `start` to the end of the file, in pieces.
export async function* sacdDsf(file, s, start = 0) {
  if (s.dst) throw new Error('DST areas are converted, not streamed as DSF');
  if (start < DSF_HEADER) { yield dsfHeader(s).subarray(start); start = DSF_HEADER; }
  const group = BLOCK * s.channels, total = perChannel(s), groups = Math.ceil(total / BLOCK);
  let index = Math.floor((start - DSF_HEADER) / group), skip = (start - DSF_HEADER) - index * group;
  if (index >= groups) return;
  const handle = await open(file, 'r');
  try {
    let offset = index * BLOCK;
    const first = Math.floor(offset / FRAME_BYTES);
    let into = offset - first * FRAME_BYTES;
    const frames = trackFrames(handle, s, first, await seekSector(handle, s, first));
    let out = Buffer.alloc(group * 16), filled = 0;
    const channels = Array.from({ length: s.channels }, () => Buffer.alloc(BLOCK)); let used = 0;
    const flush = () => {
      for (let c = 0; c < s.channels; c++) { if (used < BLOCK) channels[c].fill(0, used); channels[c].copy(out, filled + c * BLOCK); }
      filled += group; used = 0; index++;
    };
    for await (const data of frames) {
      for (let at = into; at < FRAME_BYTES; at++) {
        for (let c = 0; c < s.channels; c++) channels[c][used] = data ? reversed[data[at * s.channels + c]] : SILENCE;
        if (++used === BLOCK) {
          flush();
          if (filled === out.length) { const piece = out.subarray(skip, filled); skip = 0; yield piece; out = Buffer.alloc(group * 16); filled = 0; }
        }
      }
      into = 0;
    }
    if (used) flush();
    if (filled > skip) yield out.subarray(skip, filled);
  } finally { await handle.close(); }
}
// A DSF track answered with byte ranges, as a file on disk would be.
export async function sendSacd(req, res, file, s) {
  const size = sacdDsfSize(s);
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
    if (match && match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
    else if (match && match[2]) start = Math.max(0, size - Number(match[2]));
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    end = Math.min(end, size - 1); status = 206;
  }
  res.writeHead(status, { 'Content-Type': 'audio/x-dsf', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Length': end - start + 1, ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === 'HEAD') { res.end(); return; }
  load.stream(1);
  let closed = false, position = start;
  res.once('close', () => { closed = true; });
  try {
    for await (let piece of sacdDsf(file, s, start)) {
      if (closed) break;
      if (position + piece.length > end + 1) piece = piece.subarray(0, end + 1 - position);
      position += piece.length;
      if (!res.write(piece)) await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
      if (position > end) break;
    }
    res.end();
  } catch (error) { console.warn(`SACD read failed: ${s.image}: ${error.message}`); res.destroy(); }
  finally { load.stream(-1); }
}

// DST: a DSDIFF file with the track's DST frames, for FFmpeg to decode.
// FFmpeg's DSDIFF reader skips to the end of the sound chunk and back, so it
// needs a file, not a pipe. Written in one pass (about 1 s per track).
export async function writeSacdDff(file, s, folder) {
  const destination = path.join(folder, `sacd-${randomBytes(8).toString('hex')}.dff.part`);
  const input = await open(file, 'r'), output = await open(destination, 'w');
  try {
    const chunk = (id, size) => { const b = Buffer.alloc(12); b.write(id, 0, 'latin1'); b.writeBigUInt64BE(BigInt(size), 4); return b; };
    const ids = s.channels === 2 ? ['SLFT','SRGT'] : ['MLFT','MRGT','C   ','LFE ','LS  ','RS  '].slice(0, s.channels);
    const chnl = Buffer.concat([chunk('CHNL', 2 + 4 * ids.length), Buffer.from([0, ids.length]), Buffer.from(ids.join(''), 'latin1')]);
    const name = Buffer.from('\x0bDST Encoded', 'latin1');
    const cmpr = Buffer.concat([chunk('CMPR', 4 + name.length), Buffer.from('DST ', 'latin1'), name, name.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    const fs = Buffer.concat([chunk('FS  ', 4), Buffer.from([0x00, 0x2b, 0x11, 0x00])]);
    const prop = Buffer.concat([chunk('PROP', 4 + fs.length + chnl.length + cmpr.length), Buffer.from('SND ', 'latin1'), fs, chnl, cmpr]);
    const fver = Buffer.concat([chunk('FVER', 4), Buffer.from([1, 5, 0, 0])]);
    const head = Buffer.concat([chunk('FRM8', 0), Buffer.from('DSD ', 'latin1'), fver, prop, chunk('DST ', 0), chunk('FRTE', 6), Buffer.alloc(6)]);
    let position = head.length, count = 0, pending = [], bytes = 0;
    await output.write(head, 0, head.length, 0);
    for await (const data of trackFrames(input, s)) {
      if (!data) continue;
      pending.push(chunk('DSTF', data.length), data); if (data.length % 2) pending.push(Buffer.alloc(1));
      bytes += 12 + data.length + data.length % 2; count++;
      if (bytes >= 1 << 20) { const out = Buffer.concat(pending); await output.write(out, 0, out.length, position); position += out.length; pending = []; bytes = 0; }
    }
    if (pending.length) { const out = Buffer.concat(pending); await output.write(out, 0, out.length, position); position += out.length; }
    if (!count) throw new Error('No DST frames found');
    const sizes = Buffer.alloc(8), dstAt = 16 + fver.length + prop.length;
    sizes.writeBigUInt64BE(BigInt(position - 12)); await output.write(sizes, 0, 8, 4);
    sizes.writeBigUInt64BE(BigInt(position - dstAt - 12)); await output.write(sizes, 0, 8, dstAt + 4);
    const frte = Buffer.alloc(6); frte.writeUInt32BE(count); frte.writeUInt16BE(FPS, 4); await output.write(frte, 0, 6, dstAt + 24);
    await output.close();
    return destination;
  } catch (error) { await output.close().catch(() => {}); await unlink(destination).catch(() => {}); throw error; }
  finally { await input.close(); }
}
