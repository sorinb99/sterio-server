import { randomUUID } from 'node:crypto';
import { db } from './db.mjs';
import { HttpError } from './auth.mjs';
import { favorites, getTrack, trackView } from './library.mjs';
import { marks, profileOf } from './profiles.mjs';

// A listener's playlists, kept on the server. They belong to a profile (the
// devices of one person), and the owner can share one with other profiles to
// listen to and download; only the owner's devices change it. The track order
// is stored as a JSON list of track ids; a track that left the library is
// skipped when shown.
db.exec(`CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, track_ids TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS playlists_owner ON playlists(owner);
CREATE TABLE IF NOT EXISTS playlist_shares (playlist_id TEXT NOT NULL, profile_id TEXT NOT NULL, PRIMARY KEY(playlist_id,profile_id));`);
const MAX_TRACKS = 5000;
const trackId = /^[a-f0-9]{64}$/;
// A playlist this device's profile owns (to change), or may see (shared).
function owned(device, id) {
  const row = db.prepare('SELECT * FROM playlists WHERE id=? AND owner=?').get(id, profileOf(device.id));
  if (!row) {
    if (visible(device, id)) throw new HttpError(403, 'Only its owner can change a shared playlist');
    throw new HttpError(404, 'Playlist not found');
  }
  return row;
}
function visible(device, id) {
  const profile = profileOf(device.id);
  return db.prepare('SELECT playlists.* FROM playlists WHERE id=? AND (owner=? OR EXISTS (SELECT 1 FROM playlist_shares WHERE playlist_id=playlists.id AND profile_id=?))').get(id, profile, profile);
}
const profileName = id => db.prepare('SELECT name FROM profiles WHERE id=?').get(id)?.name || 'Listener';
function cleanName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'Enter a playlist name');
  return name;
}
function cleanIds(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !trackId.test(id))) throw new HttpError(400, 'Invalid track list');
  return value;
}
function ids(row) {
  try { return JSON.parse(row.track_ids); } catch { return []; }
}
// The tracks still in the library, in playlist order.
function tracks(row) {
  return ids(row).map(id => getTrack(id)).filter(Boolean);
}
// A list entry: counts, length and up to four covers, without the tracks.
// Shared ones say whose they are; the owner's say whom they are shared with.
function summary(row, profile) {
  const items = tracks(row);
  const covers = [];
  for (const track of items) {
    const view = trackView(track, new Set());
    if (!covers.some(cover => cover.albumId === view.albumId)) covers.push({ albumId: view.albumId, albumImageTag: view.albumImageTag });
    if (covers.length >= 4) break;
  }
  return {
    id: row.id, name: row.name, created: row.created, updated: row.updated,
    trackCount: items.length,
    durationMs: items.reduce((sum, track) => sum + (track.durationMs || 0), 0),
    covers,
    ...(row.owner === profile
      ? { sharedWith: db.prepare('SELECT profile_id FROM playlist_shares WHERE playlist_id=?').all(row.id).map(item => item.profile_id) }
      : { readonly: true, ownerName: profileName(row.owner) }),
  };
}
export function listPlaylists(device) {
  const profile = profileOf(device.id);
  const rows = db.prepare('SELECT * FROM playlists WHERE owner=? OR id IN (SELECT playlist_id FROM playlist_shares WHERE profile_id=?) ORDER BY updated DESC').all(profile, profile);
  return { items: rows.map(row => summary(row, profile)) };
}
export function getPlaylist(device, id) {
  const row = visible(device, id);
  if (!row) throw new HttpError(404, 'Playlist not found');
  const favoriteIds = favorites(device.id);
  return { ...summary(row, profileOf(device.id)), tracks: tracks(row).map(track => trackView(track, favoriteIds)) };
}
// The profiles this playlist is shared with, replaced as a whole.
export function sharePlaylist(device, id, input) {
  owned(device, id);
  const own = profileOf(device.id);
  const list = Array.isArray(input.profileIds) ? [...new Set(input.profileIds.filter(item => typeof item === 'string' && item !== own))] : null;
  if (!list || list.length > 100) throw new HttpError(400, 'Invalid share list');
  const known = list.length ? new Set(db.prepare(`SELECT id FROM profiles WHERE id IN (${marks(list)})`).all(...list).map(row => row.id)) : new Set();
  db.prepare('DELETE FROM playlist_shares WHERE playlist_id=?').run(id);
  for (const profile of list) if (known.has(profile)) db.prepare('INSERT INTO playlist_shares VALUES (?,?)').run(id, profile);
  return getPlaylist(device, id);
}
export function createPlaylist(device, input) {
  const trackIds = cleanIds(input.trackIds || []).slice(0, MAX_TRACKS);
  const now = Date.now(), id = randomUUID();
  db.prepare('INSERT INTO playlists VALUES (?,?,?,?,?,?)').run(id, profileOf(device.id), cleanName(input.name), JSON.stringify(trackIds), now, now);
  return getPlaylist(device, id);
}
// name renames; trackIds replaces the whole order (remove, reorder).
export function updatePlaylist(device, id, input) {
  const row = owned(device, id);
  const name = input.name === undefined ? row.name : cleanName(input.name);
  const trackIds = input.trackIds === undefined ? ids(row) : cleanIds(input.trackIds);
  if (trackIds.length > MAX_TRACKS) throw new HttpError(400, `A playlist holds up to ${MAX_TRACKS} tracks`);
  db.prepare('UPDATE playlists SET name=?, track_ids=?, updated=? WHERE id=?').run(name, JSON.stringify(trackIds), Date.now(), id);
  return getPlaylist(device, id);
}
// Adds to the end; a track already in the playlist is not added twice.
export function addToPlaylist(device, id, input) {
  const row = owned(device, id);
  const current = ids(row), present = new Set(current);
  const added = cleanIds(input.trackIds || []).filter(item => !present.has(item) && present.add(item));
  if (current.length + added.length > MAX_TRACKS) throw new HttpError(400, `A playlist holds up to ${MAX_TRACKS} tracks`);
  db.prepare('UPDATE playlists SET track_ids=?, updated=? WHERE id=?').run(JSON.stringify([...current, ...added]), Date.now(), id);
  return { ...getPlaylist(device, id), added: added.length };
}
export function deletePlaylist(device, id) {
  owned(device, id);
  db.prepare('DELETE FROM playlists WHERE id=?').run(id);
  db.prepare('DELETE FROM playlist_shares WHERE playlist_id=?').run(id);
  return { ok: true };
}
