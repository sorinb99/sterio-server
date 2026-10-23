import { randomBytes } from 'node:crypto';
import { db, hash, setSetting } from './db.mjs';
import { HttpError, limit } from './auth.mjs';
import { scanLibrary, scanStatus, scanIntervalMinutes, scanIntervals, setScanInterval } from './library.mjs';
import { splitSummary, startSplit, stopSplit } from './split.mjs';
import { decideRequest, pendingRequests } from './requests.mjs';
// Server administration from the app, for devices made admin in the LAN admin panel.
export const isAdmin = deviceId => Boolean(db.prepare('SELECT 1 FROM device_admins WHERE device_id=?').get(deviceId));
export function setDeviceAdmin(input) {
  if (typeof input.deviceId !== 'string' || !db.prepare('SELECT id FROM devices WHERE id=?').get(input.deviceId) || typeof input.admin !== 'boolean') throw new HttpError(400, 'Invalid device');
  if (input.admin) db.prepare('INSERT OR IGNORE INTO device_admins VALUES (?)').run(input.deviceId);
  else db.prepare('DELETE FROM device_admins WHERE device_id=?').run(input.deviceId);
}
// Removes a device or linked server: its key is deleted, so it has to ask to
// connect again. Its history stays for the reports.
export function removeDevice(input) {
  const id = typeof input.deviceId === 'string' && db.prepare('SELECT id FROM devices WHERE id=?').get(input.deviceId)?.id;
  if (!id) throw new HttpError(400, 'Invalid device');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE devices SET revoked=1, public_key='' WHERE id=?").run(id);
    db.prepare('DELETE FROM sessions WHERE device_id=?').run(id);
    db.prepare('DELETE FROM device_admins WHERE device_id=?').run(id);
    db.prepare('DELETE FROM peer_clients WHERE device_id=?').run(id);
    db.prepare('DELETE FROM control_groups WHERE device_id=? OR group_id=?').run(id, id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.log(`Device removed: ${id.slice(0, 12)}`);
  return { ok: true };
}
const deviceList = () => db.prepare("SELECT devices.id,devices.name,device_admins.device_id IS NOT NULL AS admin,peer_clients.device_id IS NOT NULL AS server FROM devices LEFT JOIN device_admins ON device_admins.device_id=devices.id LEFT JOIN peer_clients ON peer_clients.device_id=devices.id WHERE devices.revoked=0 AND devices.public_key<>'' ORDER BY devices.name").all()
  .map(row => ({ ...row, admin: Boolean(row.admin), server: Boolean(row.server) }));
export async function appAdmin(route, method, device, body) {
  if (!route.startsWith('/v1/admin/')) return null;
  limit('app-admin:' + device.id, 60);
  // Lets the app decide whether to show Server administration at all.
  if (method === 'GET' && route === '/v1/admin/access') return { admin: isAdmin(device.id) };
  // 403, not 401: a 401 means an expired device session to the app.
  if (!isAdmin(device.id)) throw Object.assign(new HttpError(403, 'This device is not a server administrator'), { code: 'not_admin' });
  if (method === 'GET' && route === '/v1/admin/status') return { scan: { ...scanStatus, intervalMinutes: scanIntervalMinutes(), intervals: scanIntervals }, split: await splitSummary() };
  if (method === 'GET' && route === '/v1/admin/requests') return { items: pendingRequests() };
  if (method === 'POST' && route === '/v1/admin/requests/decide') return decideRequest(await body());
  if (method === 'GET' && route === '/v1/admin/devices') return { items: deviceList(), self: device.id };
  if (method === 'POST' && route === '/v1/admin/devices/remove') {
    const input = await body();
    if (input.deviceId === device.id) throw new HttpError(400, 'This is the device you are using. Remove it from another device or from the dashboard.');
    return removeDevice(input);
  }
  if (method === 'POST' && route === '/v1/admin/scan') { if (!scanStatus.running) void scanLibrary().catch(error => console.error('App admin scan:', error.message)); return { ok: true }; }
  if (method === 'POST' && route === '/v1/admin/scan/interval') {
    if (!setScanInterval(Number((await body()).minutes))) throw new HttpError(400, 'Choose one of the offered scan intervals.');
    return { intervalMinutes: scanIntervalMinutes() };
  }
  if (method === 'POST' && route === '/v1/admin/split/start') return startSplit({ force: (await body()).force === true });
  if (method === 'POST' && route === '/v1/admin/split/stop') return stopSplit();
  if (method === 'POST' && route === '/v1/admin/key') {
    limit('app-admin-key:' + device.id, 10);
    const code = randomBytes(8).toString('hex'), expires = Date.now() + 5 * 60 * 1000;
    setSetting('pairing', JSON.stringify({ hash: hash(code), expires }));
    console.log(`Pairing code generated from the app by device ${device.id.slice(0, 12)}`);
    return { code, expires };
  }
  throw new HttpError(404, 'Endpoint not found');
}
