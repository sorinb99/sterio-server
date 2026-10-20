import { mkdir, readdir, rename, unlink, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { db } from './db.mjs';
import { cueTracks, getCatalog, getTrack, musicPath, processFile, scanLibrary, LEGACY_SPLIT_FOLDER, SPLIT_FOLDER, SPLIT_MARKER } from './library.mjs';
// Writes each CUE chapter as its own FLAC next to the album image, so clients
// get ordinary tracks: fast start and exact seeking. The image and CUE stay
// untouched; a marker ties the folder to the exact source version it came from.
export const splitStatus = { running: false, force: false, total: 0, done: 0, skipped: 0, current: '', errors: [], finished: null, stop: false };
const safeName = value => String(value).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120) || 'Track';
function splitSets() {
  const sets = new Map();
  for (const chapter of cueTracks()) {
    if (!sets.has(chapter.sourceId)) sets.set(chapter.sourceId, []);
    sets.get(chapter.sourceId).push(chapter);
  }
  const folders = new Map();
  for (const [sourceId, chapters] of sets) {
    const source = getTrack(sourceId);
    // Only an album image (several chapters in one file) is split. A CUE that
    // indexes one file per track describes tracks that already exist.
    // DSD images stay whole: a FLAC copy would be a PCM conversion, not a split.
    if (!source || chapters.length < 2 || source.dsd) { sets.delete(sourceId); continue; }
    chapters.sort((a, b) => a.segment.startSeconds - b.segment.startSeconds);
    const folder = path.dirname(source.path);
    folders.set(folder, (folders.get(folder) || 0) + 1);
  }
  return [...sets].filter(([sourceId]) => getTrack(sourceId)).map(([sourceId, chapters]) => {
    const source = getTrack(sourceId), folder = path.dirname(source.path);
    // Two images in one folder (CD1/CD2 side by side) each get their own subfolder.
    const output = folders.get(folder) > 1 ? path.join(folder, SPLIT_FOLDER, safeName(path.basename(source.path, path.extname(source.path)))) : path.join(folder, SPLIT_FOLDER);
    return { source, chapters, output };
  });
}
const matches = (marker, set) => marker.version === 2 && marker.complete === true && marker.source === set.source.path && marker.size === set.source.size && marker.mtime === set.source.mtime && marker.files?.length === set.chapters.length;
// Fast path without disk access: the last scan already read the marker and
// indexed the split files, so a finished album is recognised from memory.
function indexed(set, files) {
  try {
    const row = db.prepare('SELECT metadata FROM split_sets WHERE folder=?').get(set.output);
    const marker = row && JSON.parse(row.metadata);
    return Boolean(marker && matches(marker, set) && marker.files.every(file => files.has(path.join(set.output, file.file))));
  } catch { return false; }
}
async function current(set, files) {
  if (files && indexed(set, files)) return true;
  try {
    const marker = JSON.parse(await readFile(path.join(config.music, set.output, SPLIT_MARKER), 'utf8'));
    if (!matches(marker, set)) return false;
    for (const file of marker.files) await stat(path.join(config.music, set.output, file.file));
    return true;
  } catch { return false; }
}
const indexedFiles = () => new Set(getCatalog().map(item => item.path));
export async function splitSummary() {
  const sets = splitSets(), files = indexedFiles(); let split = 0;
  for (const set of sets) if (await current(set, files)) split++;
  return { albums: sets.length, split, status: { ...splitStatus, errors: splitStatus.errors.slice(-10) } };
}
async function writeChapter(set, chapter, index, file) {
  const { source } = set, rate = source.format.sampleRate;
  const startSample = Math.round(chapter.segment.startSeconds * rate);
  const samples = Math.round(chapter.segment.endSeconds * rate) - startSample;
  // The last chapter runs to the end of the image; its CUE end is the rounded duration.
  const last = index === set.chapters.length - 1;
  const directory = path.join(config.music, set.output), final = path.join(directory, file), temp = path.join(directory, `.${file}.part`);
  const tags = { title: chapter.title, artist: chapter.artist, album: chapter.album, album_artist: chapter.albumArtist, track: `${chapter.number || index + 1}/${set.chapters.length}`, disc: source.disc, date: source.year, genre: (source.genres || []).filter(name => name !== 'Uncategorized').join('; ') };
  const metadata = Object.entries(tags).filter(([, value]) => value).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]);
  try {
    // Same sample-exact extraction as CUE delivery: accurate input seek, then
    // atrim fixes the output sample count. Encoded once, at a normal FLAC level.
    await processFile('ffmpeg', ['-v','error','-nostdin','-y','-protocol_whitelist','file','-ss',(startSample / rate).toFixed(9),'-i',await musicPath(source.path),
      ...(last ? [] : ['-t',(samples / rate).toFixed(9)]),'-map','0:a:0','-map_metadata','-1','-vn','-sn','-dn',...(last ? [] : ['-af',`atrim=end_sample=${samples}`]),...metadata,
      '-c:a','flac','-compression_level','5','-frame_size','4096','-f','flac',temp], 30 * 60 * 1000);
    // Seek points make HTTP seeking in AVFoundation exact and immediate.
    await processFile('metaflac', ['--add-seekpoint=1s', temp], 5 * 60 * 1000);
    await rename(temp, final);
  } finally { await unlink(temp).catch(() => {}); }
}
async function splitAlbum(set) {
  const directory = path.join(config.music, set.output);
  // Never write into a folder the server did not create.
  const existing = await readdir(directory).catch(() => null);
  if (existing && existing.length && !existing.includes(SPLIT_MARKER) && !existing.every(name => name.startsWith('.') && name.endsWith('.part')))
    throw new Error(`${set.output} already exists and was not created by Sterio`);
  await mkdir(directory, { recursive: true });
  const files = set.chapters.map((chapter, index) => ({ number: chapter.number || index + 1, chapterId: chapter.id, file: `${String(chapter.number || index + 1).padStart(2, '0')} - ${safeName(chapter.title)}.flac` }));
  // Version 2: the last track runs to the end of the image (v1 lost its rounded tail).
  const marker = { version: 2, complete: false, source: set.source.path, cue: set.chapters[0].cuePath, size: set.source.size, mtime: set.source.mtime, files };
  // Claim the folder first, so an interrupted run can resume it safely.
  await writeFile(path.join(directory, SPLIT_MARKER), JSON.stringify(marker, null, 2));
  for (let index = 0; index < set.chapters.length; index++) {
    if (splitStatus.stop) throw new Error('Stopped');
    splitStatus.current = `${set.chapters[index].album} · ${files[index].file}`;
    await writeChapter(set, set.chapters[index], index, files[index].file);
  }
  // Completed last: an interrupted album is never mistaken for a complete one.
  await writeFile(path.join(directory, SPLIT_MARKER), JSON.stringify({ ...marker, complete: true, created: new Date().toISOString() }, null, 2));
  // A forced re-split can rename tracks: remove FLAC files the marker no longer lists.
  const keep = new Set(files.map(file => file.file));
  for (const name of await readdir(directory)) if (name.toLowerCase().endsWith('.flac') && !keep.has(name)) await unlink(path.join(directory, name)).catch(() => {});
}
// force: rewrite albums that are already split as well. Each file is replaced
// atomically, so the album stays playable while it is rewritten.
export function startSplit({ force = false } = {}) {
  if (splitStatus.running) return { ...splitStatus };
  Object.assign(splitStatus, { running: true, force: force === true, total: 0, done: 0, skipped: 0, current: '', errors: [], finished: null, stop: false });
  void (async () => {
    try {
      // Albums already split are set aside first: the run only visits the rest.
      const sets = splitSets(), files = indexedFiles(), todo = [];
      for (const set of sets) if (!splitStatus.force && await current(set, files)) splitStatus.skipped++; else todo.push(set);
      splitStatus.total = todo.length;
      console.log(`Album split${splitStatus.force ? ' (forced)' : ''}: ${todo.length} to split, ${splitStatus.skipped} already split`);
      for (const set of todo) {
        if (splitStatus.stop) break;
        const started = Date.now();
        try {
          await splitAlbum(set);
          console.log(`Album split: "${set.chapters[0].album}" ${set.chapters.length} tracks in ${Date.now() - started} ms -> ${set.output}`);
        } catch (error) {
          if (splitStatus.stop) break;
          const reason = ['EROFS', 'EACCES', 'EPERM'].includes(error.code) ? 'The music folder is read-only for the server. Set MUSIC_ACCESS=rw in .env and restart the container.' : error.message;
          splitStatus.errors.push(`${set.source.path}: ${reason}`); console.warn(`Album split failed: ${set.source.path}: ${error.message}`);
          if (reason !== error.message) break;
        } finally { splitStatus.done++; }
      }
    } finally {
      Object.assign(splitStatus, { running: false, current: '', finished: new Date().toISOString() });
      void scanLibrary().catch(error => console.error('Scan after split:', error.message));
    }
  })();
  return { ...splitStatus };
}
// Earlier versions wrote a visible Tracks folder. Rename it to the hidden folder
// when everything in it was written by the server; anything else stays as is.
async function serverMade(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => entry.name === SPLIT_MARKER)) return true;
  const folders = entries.filter(entry => entry.isDirectory());
  if (!folders.length || entries.some(entry => !entry.isDirectory() && !entry.name.startsWith('.'))) return false;
  for (const folder of folders) if (!(await readdir(path.join(directory, folder.name))).includes(SPLIT_MARKER)) return false;
  return true;
}
export async function migrateSplitFolders() {
  const albums = new Set();
  for (const { folder } of db.prepare('SELECT folder FROM split_sets').all()) {
    const parts = folder.split(path.sep), index = parts.lastIndexOf(LEGACY_SPLIT_FOLDER);
    if (index >= 0 && index >= parts.length - 2) albums.add(parts.slice(0, index).join(path.sep));
  }
  let moved = 0;
  for (const album of albums) {
    const legacy = path.join(config.music, album, LEGACY_SPLIT_FOLDER), hidden = path.join(config.music, album, SPLIT_FOLDER);
    try {
      if (!(await serverMade(legacy))) { console.warn(`Split folder not moved (unexpected content): ${path.join(album, LEGACY_SPLIT_FOLDER)}`); continue; }
      if (await stat(hidden).then(() => true, () => false)) { console.warn(`Split folder not moved (${SPLIT_FOLDER} exists): ${album}`); continue; }
      await rename(legacy, hidden); moved++;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      console.warn(`Split folder not moved: ${album}: ${error.message}`);
      if (['EROFS', 'EACCES', 'EPERM'].includes(error.code)) break;
    }
  }
  if (moved) console.log(`Split folders hidden: ${moved} albums moved to ${SPLIT_FOLDER}`);
  return moved;
}
export function stopSplit() { if (splitStatus.running) splitStatus.stop = true; return { ...splitStatus }; }
