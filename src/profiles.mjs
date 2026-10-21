import { randomBytes, randomUUID } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { db, hash } from './db.mjs';
import { HttpError, limit } from './auth.mjs';

// A listener's profile: the devices of one person (a phone and a laptop).
// Playlists, favorites, listening history and radio likes belong to the
// profile, so every device in it sees the same ones. A device joins a profile
// with a short code made on a device already in it; there are no passwords,
// each device already signs in with its own key.
db.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS profile_devices (device_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_invites (hash TEXT PRIMARY KEY, profile_id TEXT NOT NULL, device_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS control_groups (device_id TEXT PRIMARY KEY, group_id TEXT NOT NULL);`);
const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const deviceName = id => {
  const row = db.prepare("SELECT devices.name, coalesce(playback_listeners.label,'') AS label FROM devices LEFT JOIN playback_listeners ON playback_listeners.device_id=devices.id WHERE devices.id=?").get(id);
  return text(row?.label || row?.name || 'Listener', 80) || 'Listener';
};
function create(name) {
  const id = randomUUID();
  db.prepare('INSERT INTO profiles VALUES (?,?,?)').run(id, text(name, 80) || 'Listener', Date.now());
  return id;
}
function assign(deviceId, profileId) {
  db.prepare('INSERT INTO profile_devices VALUES (?,?) ON CONFLICT(device_id) DO UPDATE SET profile_id=excluded.profile_id').run(deviceId, profileId);
}
// The profile of a device, made on first use: devices already paired for
// Play on (a phone and its Mac) share one.
export function profileOf(deviceId) {
  const row = db.prepare('SELECT profile_id FROM profile_devices WHERE device_id=?').get(deviceId);
  if (row) return row.profile_id;
  const group = db.prepare('SELECT group_id FROM control_groups WHERE device_id=?').get(deviceId)?.group_id
    || (db.prepare('SELECT 1 FROM control_groups WHERE group_id=?').get(deviceId) ? deviceId : null);
  const members = group ? db.prepare('SELECT device_id FROM control_groups WHERE group_id=?').all(group).map(item => item.device_id).concat(group) : [];
  const existing = members.map(id => db.prepare('SELECT profile_id FROM profile_devices WHERE device_id=?').get(id)?.profile_id).find(Boolean);
  const profile = existing || create(deviceName(deviceId));
  assign(deviceId, profile);
  // Playlists made before profiles belonged to the device.
  db.prepare('UPDATE playlists SET owner=? WHERE owner=?').run(profile, deviceId);
  return profile;
}
export function profileDevices(deviceId) {
  return db.prepare('SELECT device_id FROM profile_devices WHERE profile_id=?').all(profileOf(deviceId)).map(row => row.device_id);
}
export const sameProfile = (a, b) => a === b || profileOf(a) === profileOf(b);
// SQL placeholders for a list of ids.
export const marks = list => list.map(() => '?').join(',');
// Every device gets its profile at start, so lists and shares are complete.
if (isMainThread) {
  db.exec(`CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, track_ids TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS playback_listeners (device_id TEXT PRIMARY KEY, label TEXT NOT NULL);`);
  for (const row of db.prepare('SELECT id FROM devices WHERE revoked=0 ORDER BY created').all()) profileOf(row.id);
}
export function profileView(device) {
  const id = profileOf(device.id);
  const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(id);
  const devices = db.prepare('SELECT devices.id, devices.name FROM profile_devices JOIN devices ON devices.id=profile_devices.device_id WHERE profile_devices.profile_id=? AND devices.revoked=0 ORDER BY devices.created').all(id);
  // Other listeners on this server, to share playlists with.
  const others = db.prepare(`SELECT profiles.id, profiles.name FROM profiles WHERE id<>? AND EXISTS (SELECT 1 FROM profile_devices JOIN devices ON devices.id=profile_devices.device_id WHERE profile_devices.profile_id=profiles.id AND devices.revoked=0) ORDER BY name`).all(id);
  return {
    id, name: profile?.name || 'Listener',
    devices: devices.map(item => ({ id: item.id, name: deviceName(item.id), self: item.id === device.id })),
    profiles: others,
  };
}
export function renameProfile(device, input) {
  const name = text(input.name, 80);
  if (!name) throw new HttpError(400, 'Enter a name');
  db.prepare('UPDATE profiles SET name=? WHERE id=?').run(name, profileOf(device.id));
  return profileView(device);
}
// Six characters without look-alikes, valid for five minutes, used once.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function createProfileLink(device) {
  limit('profile-link:' + device.id, 10);
  const bytes = randomBytes(6);
  const code = [...bytes].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
  db.prepare('DELETE FROM profile_invites WHERE expires<? OR device_id=?').run(Date.now(), device.id);
  const expires = Date.now() + 300000;
  db.prepare('INSERT INTO profile_invites VALUES (?,?,?,?)').run(hash(code), profileOf(device.id), device.id, expires);
  return { code, expires };
}
// This device moves into the profile of the code. A profile left without
// devices hands its playlists over and is removed.
export function joinProfile(device, input) {
  limit('profile-join:' + device.id, 10);
  const code = text(input.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const invite = db.prepare('SELECT profile_invites.* FROM profile_invites JOIN devices ON devices.id=profile_invites.device_id WHERE hash=? AND expires>? AND devices.revoked=0').get(hash(code), Date.now());
  if (!invite) throw new HttpError(403, 'Invalid or expired code');
  db.prepare('DELETE FROM profile_invites WHERE hash=?').run(hash(code));
  const previous = profileOf(device.id);
  if (previous === invite.profile_id) return profileView(device);
  db.exec('BEGIN IMMEDIATE');
  try {
    assign(device.id, invite.profile_id);
    if (!db.prepare('SELECT 1 FROM profile_devices WHERE profile_id=?').get(previous)) {
      db.prepare('UPDATE playlists SET owner=? WHERE owner=?').run(invite.profile_id, previous);
      db.prepare('DELETE FROM playlist_shares WHERE profile_id=?').run(previous);
      db.prepare('DELETE FROM profiles WHERE id=?').run(previous);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return profileView(device);
}
// This device starts a profile of its own; the playlists stay with the old one.
export function leaveProfile(device) {
  if (profileDevices(device.id).length <= 1) return profileView(device);
  assign(device.id, create(deviceName(device.id)));
  return profileView(device);
}
