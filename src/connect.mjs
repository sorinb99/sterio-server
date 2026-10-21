import { randomBytes, randomUUID } from 'node:crypto';
import { observePulse } from './reporting.mjs';
import { db, hash } from './db.mjs';
import { HttpError, limit } from './auth.mjs';
import { getTrack, trackView } from './library.mjs';
import { sameProfile } from './profiles.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS control_groups (device_id TEXT PRIMARY KEY, group_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_invites (hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires INTEGER NOT NULL);`);
const presence = new Map(), commands = new Map();
const group = id => db.prepare('SELECT group_id FROM control_groups WHERE device_id=?').get(id)?.group_id || id;
const online = item => item && Date.now() - item.seen < 12000;
// Paired for Play on, or devices of the same listener (profile).
export const related = (a, b) => group(a) === group(b) || sameProfile(a, b);
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
function ids(value) {
  if (!Array.isArray(value) || value.length > 200 || value.some(id => !validId(id) || !getTrack(id))) throw new HttpError(400, 'Invalid playback queue (maximum 200 tracks)');
  return value;
}
export function createLink(device) {
  limit('link-create:' + device.id, 10);
  const code = randomBytes(4).toString('hex').toUpperCase();
  db.prepare('DELETE FROM control_invites WHERE expires<? OR device_id=?').run(Date.now(), device.id);
  db.prepare('INSERT INTO control_invites VALUES (?,?,?)').run(hash(code), device.id, Date.now()+300000);
  return {code, expiresIn:300};
}
export function joinLink(device, input) {
  limit('link-join:' + device.id, 10);
  const code = String(input.code || '').trim().toUpperCase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const invite = db.prepare('SELECT control_invites.* FROM control_invites JOIN devices ON devices.id=control_invites.device_id WHERE hash=? AND expires>? AND devices.revoked=0').get(hash(code), Date.now());
    if (!invite || invite.device_id === device.id) throw new HttpError(403, 'Invalid or expired link code');
    const groupId = group(invite.device_id);
    db.prepare('INSERT INTO control_groups VALUES (?,?) ON CONFLICT(device_id) DO UPDATE SET group_id=excluded.group_id').run(device.id, groupId);
    db.prepare('DELETE FROM control_invites WHERE hash=?').run(hash(code));
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  return {ok:true};
}
export function pulse(device, input) {
  const state = input.state || {};
  const trackIds = ids(state.trackIds || []);
  const index = Number.isInteger(state.index) && state.index >= 0 && state.index < trackIds.length ? state.index : 0;
  const status = ['idle','buffering','playing','paused','interrupted','ended','error'].includes(state.status) ? state.status : 'idle';
  if (presence.get(device.id)?.instance !== input.instance) commands.delete(device.id);
  presence.set(device.id, {instance:String(input.instance||'').slice(0,80),id:device.id, name:String(input.name || device.name).slice(0,80), platform:input.platform === 'macos' ? 'macos' : 'mobile', seen:Date.now(),
    state:{trackIds,index,status,position:Math.max(0,Math.min(604800,Number(state.position)||0)),duration:Math.max(0,Math.min(604800,Number(state.duration)||0)),route:String(state.route || 'System output').slice(0,120),error:state.error ? String(state.error).slice(0,200) : null}});
  observePulse(device,presence.get(device.id).state,input.platform === 'macos' ? 'macos' : 'mobile');
  const ack = new Set(Array.isArray(input.ack) ? input.ack.slice(0,32) : []);
  commands.set(device.id,(commands.get(device.id) || []).filter(item => !ack.has(item.id)));
  for (const [id,item] of presence) if (Date.now()-item.seen > 60000) { presence.delete(id); commands.delete(id); }
  return connectView(device);
}
// What a device sees: its linked devices online (Macs and phones, each can
// control the other) and the commands waiting for it.
export function connectView(device) {
  const pending = (commands.get(device.id) || []).filter(item => item.expires > Date.now() && db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(item.sender) && related(item.sender, device.id));
  commands.set(device.id,pending);
  const devices = [...presence.values()].filter(item => item.id !== device.id && online(item) && related(item.id, device.id) && db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(item.id)).map(item => ({...item,state:{...item.state, tracks:item.state.trackIds.map(id => getTrack(id)).filter(Boolean).map(track => trackView(track,new Set()))}}));
  return {devices,commands:pending.map(({sender,expires,...command}) => command),linked:linkedDevices(device),...pairingView(device)};
}
// Every other device paired with this one, online or not, so either side can unpair.
function linkedDevices(device) {
  const own = group(device.id);
  const ids = new Set(db.prepare('SELECT device_id FROM control_groups WHERE group_id=?').all(own).map(row => row.device_id));
  ids.add(own);
  ids.delete(device.id);
  return [...ids].map(id => db.prepare('SELECT id,name FROM devices WHERE id=? AND revoked=0').get(id)).filter(Boolean)
    .map(row => { const item = presence.get(row.id); return {id:row.id, name:online(item) ? item.name : row.name, platform:item?.platform || null, online:online(item)}; });
}
export function unpair(device, input) {
  limit('unpair:' + device.id, 30);
  const other = String(input.id || '');
  if (!validId(other) || other === device.id || group(other) !== group(device.id)) return {ok:true};
  // The device that joined the other's group leaves it; a group root stays where it is.
  const leaving = group(other) !== other ? other : device.id;
  db.prepare('DELETE FROM control_groups WHERE device_id=?').run(leaving);
  commands.delete(other); commands.delete(device.id);
  return {ok:true};
}
export const controlGroup = group;
export function sendCommand(device, input) {
  limit('control:' + device.id,120);
  const target = presence.get(input.target);
  if (!online(target) || !db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(input.target) || !related(input.target, device.id)) throw new HttpError(409,'Device unavailable. Open Sterio on it.');
  if (!['toggle','next','previous','seek','play'].includes(input.action)) throw new HttpError(400,'Unknown playback command');
  const args = {};
  if (input.action === 'seek') {
    if (!Number.isFinite(input.position) || input.position < 0 || input.position > 604800) throw new HttpError(400,'Invalid seek position');
    args.position=input.position;
  }
  if (input.action === 'play') {
    args.trackIds=ids(input.trackIds);
    if (!args.trackIds.length || !Number.isInteger(input.index) || input.index<0 || input.index>=args.trackIds.length) throw new HttpError(400,'Invalid track index');
    args.index=input.index;
  }
  const pending = (commands.get(target.id)||[]).filter(item=>item.expires>Date.now());
  if (pending.length >= 32) throw new HttpError(429,'Device command queue is full');
  const command={id:randomUUID(),action:input.action,...args,sender:device.id,expires:Date.now()+30000};
  pending.push(command); commands.set(target.id,pending);
  return {ok:true};
}

// Pairing without a code: a Mac is discoverable for a few minutes, a phone on
// the same server sees it and asks, and the Mac accepts. Both show the same
// four-digit code. Kept in memory; the phone asks again while it waits.
const discoverable = new Map(), pairings = new Map();
const isLive = id => db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(id);
const pairCode = (mac, phone) => String(parseInt(hash(mac + phone).slice(0, 8), 16) % 10000).padStart(4, '0');
function prunePairing() {
  const now = Date.now();
  for (const [id, until] of discoverable) if (until < now) discoverable.delete(id);
  for (const [key, entry] of pairings) if (entry.status === 'pending' ? now - entry.seen > 30000 : now - entry.decided > 120000) pairings.delete(key);
}
function pairingView(device) {
  prunePairing();
  const own = group(device.id), item = presence.get(device.id);
  if (item?.platform === 'macos') return {
    discoverableUntil:discoverable.get(device.id) || 0,
    pairRequests:[...pairings.values()].filter(entry => entry.mac === device.id && entry.status === 'pending' && isLive(entry.phone)).map(({phone,name,code}) => ({id:phone,name,code})),
  };
  return { nearby:[...discoverable.keys()].filter(id => id !== device.id && online(presence.get(id)) && !related(id, device.id) && isLive(id)).map(id => ({id,name:presence.get(id).name})) };
}
export function setDiscoverable(device, input) {
  limit('discoverable:' + device.id, 30);
  if (presence.get(device.id)?.platform !== 'macos') throw new HttpError(400,'Only a Mac can be discoverable');
  if (input.on === true) discoverable.set(device.id, Date.now() + 5 * 60000); else discoverable.delete(device.id);
  return {discoverableUntil:discoverable.get(device.id) || 0};
}
export function requestPair(device, input) {
  limit('pair-request:' + device.id, 90);
  prunePairing();
  const mac = String(input.target || ''), key = mac + '\0' + device.id;
  if (validId(mac) && group(mac) === group(device.id)) return {status:'approved'};
  const entry = pairings.get(key);
  if (entry) { entry.seen = Date.now(); return {status:entry.status, code:entry.code}; }
  if (!validId(mac) || !discoverable.has(mac) || !online(presence.get(mac)) || !isLive(mac)) throw new HttpError(409,'That Mac is no longer discoverable. Make it discoverable again in Sterio on the Mac.');
  const created = {mac, phone:device.id, name:String(input.name || presence.get(device.id)?.name || device.name).slice(0,80), code:pairCode(mac, device.id), seen:Date.now(), status:'pending'};
  pairings.set(key, created);
  return {status:'pending', code:created.code};
}
export function decidePair(device, input) {
  limit('pair-decide:' + device.id, 60);
  const entry = pairings.get(device.id + '\0' + String(input.from || ''));
  if (!entry || entry.status !== 'pending') throw new HttpError(404,'This request is no longer waiting. Ask the phone to pair again.');
  if (input.accept === true) {
    if (!isLive(entry.phone)) throw new HttpError(404,'That phone is no longer connected to this server');
    db.prepare('INSERT INTO control_groups VALUES (?,?) ON CONFLICT(device_id) DO UPDATE SET group_id=excluded.group_id').run(entry.phone, group(device.id));
  }
  Object.assign(entry, {status:input.accept === true ? 'approved' : 'declined', decided:Date.now()});
  if (input.accept === true) discoverable.delete(device.id);
  return {ok:true};
}
