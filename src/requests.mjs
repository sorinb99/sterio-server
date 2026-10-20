import { db } from './db.mjs';
import { HttpError, parseKey } from './auth.mjs';
import { macMode } from './mac.mjs';
// Connection requests. An app or another server only needs this server's
// address: it asks to connect, and an administrator accepts or declines on the
// dashboard or in the app's Server administration. Both sides show the same
// four-digit code, so the administrator can tell which device is asking.
// Requests live in memory: the requester asks again every few seconds while
// it waits, so a restart loses nothing.
const requests = new Map();
const text = (value, max = 80) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
const codeOf = id => String(parseInt(id.slice(0, 8), 16) % 10000).padStart(4, '0');
function prune() {
  const now = Date.now();
  for (const [id, entry] of requests) {
    // A requester that stopped asking gave up; a decision is kept a few minutes.
    if (entry.status === 'pending' ? now - entry.seen > 2 * 60000 || now - entry.created > 30 * 60000 : now - entry.decided > 5 * 60000) requests.delete(id);
  }
}
const accepted = (kind, id) => kind === 'server'
  ? Boolean(db.prepare('SELECT 1 FROM peer_clients JOIN devices ON devices.id=peer_clients.device_id WHERE devices.id=? AND devices.revoked=0').get(id))
  : Boolean(db.prepare('SELECT 1 FROM devices WHERE id=? AND revoked=0 AND length(public_key)>0').get(id));
export function requestAccess(kind, body, address) {
  const parsed = parseKey(body.publicKey);
  if (kind === 'server' && (typeof body.serverId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.serverId))) throw new HttpError(400, 'Invalid server identity');
  if (accepted(kind, parsed.id)) return { status: 'approved' };
  prune();
  let entry = requests.get(parsed.id);
  if (entry?.status === 'declined') return { status: 'declined' };
  if (!entry || entry.kind !== kind) {
    if ([...requests.values()].filter(item => item.status === 'pending').length >= 30) throw new HttpError(429, 'Too many connection requests are waiting. Try again later.');
    const now = Date.now();
    entry = { id: parsed.id, kind, publicKey: parsed.encoded, serverId: kind === 'server' ? body.serverId : null, name: text(body.name) || (kind === 'server' ? 'Sterio server' : 'Sterio device'),
      code: codeOf(parsed.id), address: text(String(address || '').replace(/^::ffff:/, ''), 64), created: now, seen: now, status: 'pending' };
    requests.set(parsed.id, entry);
    console.log(`Connection request from ${kind === 'server' ? 'server' : 'device'} "${entry.name}" (code ${entry.code})`);
    // The Mac app brings the dashboard up, so the request is seen.
    if (macMode) process.stdout.write('\n@@sterio open-dashboard\n');
  }
  entry.seen = Date.now();
  return { status: 'pending', code: entry.code };
}
export function pendingRequests() {
  prune();
  return [...requests.values()].filter(entry => entry.status === 'pending').sort((a, b) => a.created - b.created)
    .map(({ id, kind, name, code, address, created }) => ({ id, kind, name, code, address, created }));
}
export function decideRequest(input) {
  const entry = typeof input.id === 'string' && requests.get(input.id);
  if (!entry || entry.status !== 'pending') throw new HttpError(404, 'This request is no longer waiting. Ask the device to connect again.');
  if (typeof input.accept !== 'boolean') throw new HttpError(400, 'Choose accept or decline');
  if (!input.accept) {
    Object.assign(entry, { status: 'declined', decided: Date.now() });
    console.log(`Connection request declined: "${entry.name}"`);
    return { ok: true };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (entry.kind === 'server') {
      db.prepare('INSERT INTO devices VALUES (?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name, public_key=excluded.public_key, revoked=0').run(entry.id, 'Server · ' + entry.name, entry.publicKey, Date.now());
      db.prepare('INSERT INTO peer_clients VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET server_id=excluded.server_id, name=excluded.name').run(entry.id, entry.serverId, entry.name, Date.now());
    } else {
      db.prepare('INSERT INTO devices VALUES (?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name, public_key=excluded.public_key, revoked=0').run(entry.id, entry.name, entry.publicKey, Date.now());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  requests.delete(entry.id);
  console.log(`Connection request accepted: ${entry.kind} "${entry.name}"`);
  return { ok: true };
}
