import { createPublicKey, verify, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { db, hash, getSetting, setSetting, serverId, ticketSecret } from './db.mjs';
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const challenges = new Map();
const limits = new Map();
export function limit(key, count = 60) {
  const now = Date.now();
  let entry = limits.get(key);
  if (!entry && limits.size >= 4096) { for (const [id,item] of limits) if (item.until < now) limits.delete(id); if (limits.size >= 4096) throw new HttpError(429, 'Request capacity reached'); }
  if (!entry || entry.until < now) { entry = { count: 0, until: now + 60000 }; limits.set(key, entry); }
  if (++entry.count > count) throw new HttpError(429, 'Too many requests. Try again in a minute.');
  if (limits.size > 2048) for (const [id, item] of limits) if (item.until < now) limits.delete(id);
}
export function parseKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 128) throw new HttpError(400, 'Invalid device public key');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length !== 65 || raw[0] !== 4) throw new HttpError(400, 'Expected an uncompressed P-256 public key');
  try {
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
    return { key, id: hash(raw), encoded: raw.toString('base64') };
  } catch { throw new HttpError(400, 'Invalid device public key'); }
}
export function pairDevice(body) {
  const parsed = parseKey(body.publicKey);
  const invite = JSON.parse(getSetting('pairing') || 'null');
  const codeHash = hash(String(body.code || '').trim());
  if (!invite || invite.expires < Date.now() || !timingSafeEqual(Buffer.from(invite.hash, 'hex'), Buffer.from(codeHash, 'hex'))) throw new HttpError(403, 'Invalid or expired pairing code. Generate a new code on the NAS.');
  const name = String(body.name || 'Sterio device').slice(0, 80);
  db.exec('BEGIN IMMEDIATE');
  try {
    // Claim the one-use invite atomically, even when the CLI runs concurrently.
    if (getSetting('pairing') !== JSON.stringify(invite)) throw new HttpError(403, 'Pairing code already used');
    setSetting('pairing', 'null');
    db.prepare('INSERT INTO devices VALUES (?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name, public_key=excluded.public_key, revoked=0').run(parsed.id, name, parsed.encoded, Date.now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { keyId: parsed.id, serverId };
}
export function challengeDevice(body) {
  const parsed = parseKey(body.publicKey);
  const device = db.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').get(parsed.id);
  if (!device) throw Object.assign(new HttpError(403, 'This device is not connected to this server yet.'), { code: 'not_paired' });
  const now = Date.now();
  for (const [id, value] of challenges) if (value.expires < now) challenges.delete(id);
  if (challenges.size >= 1024) throw new HttpError(429, 'Too many pending sign-ins');
  const id = randomBytes(24).toString('base64url');
  const message = `Sterio/v1\n${serverId}\n${parsed.id}\n${id}\n${randomBytes(32).toString('base64url')}`;
  challenges.set(id, { key: parsed.key, deviceId: parsed.id, message, expires: now + 60000 });
  return { id, message, serverId, keyId: parsed.id };
}
export function createSession(body) {
  const challenge = challenges.get(body.id);
  challenges.delete(body.id);
  if (!challenge || challenge.expires < Date.now()) throw new HttpError(401, 'Sign-in challenge expired');
  let valid = false;
  try { valid = typeof body.signature === 'string' && body.signature.length < 256 && verify('sha256', Buffer.from(challenge.message), challenge.key, Buffer.from(body.signature, 'base64')); } catch {}
  if (!valid || !db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(challenge.deviceId)) throw new HttpError(401, 'Device signature was not accepted');
  const token = randomBytes(32).toString('base64url');
  const expires = Date.now() + 30 * 60 * 1000;
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), challenge.deviceId, expires);
  return { accessToken: token, expires, keyId: challenge.deviceId, serverId };
}
export function authenticate(req) {
  const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new HttpError(401, 'Sign-in required');
  const device = db.prepare('SELECT devices.* FROM sessions JOIN devices ON devices.id=sessions.device_id WHERE sessions.hash=? AND sessions.expires>? AND devices.revoked=0').get(hash(token), Date.now());
  if (!device) throw new HttpError(401, 'Sign-in expired');
  return device;
}
export function streamTicket(trackId, deviceId, mode) {
  const payload = Buffer.from(JSON.stringify({ t: trackId, d: deviceId, m: mode, e: Date.now() + 24 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', ticketSecret).update(payload).digest('base64url')}`;
}
export function verifyTicket(ticket, trackId) {
  if (typeof ticket !== 'string' || ticket.length > 1024) throw new HttpError(401, 'Stream authorization required');
  const [payload, signature, extra] = ticket.split('.');
  const expected = createHmac('sha256', ticketSecret).update(payload || '').digest();
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'Invalid stream ticket');
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url')); } catch { throw new HttpError(401, 'Invalid stream ticket'); }
  if (value.t !== trackId || !Number.isFinite(value.e) || value.e < Date.now() || !['original','pcm','verbatim','lossless','cue','cueverbatim'].includes(value.m) || !db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(value.d)) throw new HttpError(401, 'Stream ticket expired or device revoked');
  return value;
}
