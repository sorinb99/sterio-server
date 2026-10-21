import { createHash } from 'node:crypto';
import { db, hash } from './db.mjs';
import { limit } from './auth.mjs';
import { connectView, pulse, related, sendCommand } from './connect.mjs';
import { requestListeners } from './requests.mjs';
import { updateDeviceNickname } from './reporting.mjs';
import { load } from './load.mjs';

// Play on between a phone and a linked Mac over one WebSocket each: a command
// reaches the Mac and the Mac's new state reaches the phone as soon as they
// happen, instead of on the next 2-second pulse. HTTP pulses keep working for
// older apps and wherever a proxy does not pass WebSockets.
// Text frames carry JSON. The first message signs in with the app's token.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024;
const sockets = new Set();

function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(length)); return size; })()]);
  return Buffer.concat([head, payload]);
}
function send(client, message) {
  if (!client.socket.destroyed) client.socket.write(frame(1, Buffer.from(JSON.stringify(message))));
}
function close(client, code = 1000) {
  if (client.closed) return;
  client.closed = true;
  if (sockets.delete(client)) load.socket(-1);
  clearInterval(client.ping);
  const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
  try { client.socket.end(frame(8, payload)); } catch {}
  setTimeout(() => client.socket.destroy(), 1000).unref();
}
function signedIn(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare('SELECT devices.* FROM sessions JOIN devices ON devices.id=sessions.device_id WHERE sessions.hash=? AND sessions.expires>? AND devices.revoked=0').get(hash(token), Date.now()) || null;
}
function stillLinked(device) {
  return !!db.prepare('SELECT id FROM devices WHERE id=? AND revoked=0').get(device.id);
}
// Everyone else in the device's control group gets what they see now.
function notifyGroup(device, skipSelf = true) {
  for (const client of sockets) {
    if (!client.device || (skipSelf && client.device.id === device.id) || !related(client.device.id, device.id)) continue;
    try { send(client, { type: 'pulse', ...connectView(client.device) }); } catch {}
  }
}
// A new or decided connection request reaches the administrators' apps at once.
requestListeners.add(() => {
  for (const client of sockets) {
    if (!client.device || !db.prepare('SELECT 1 FROM device_admins WHERE device_id=?').get(client.device.id)) continue;
    try { send(client, { type: 'pulse', ...connectView(client.device) }); } catch {}
  }
});
function handle(client, message) {
  if (message.type === 'auth') {
    const device = signedIn(message.token);
    if (!device) { send(client, { type: 'error', message: 'Sign-in expired' }); close(client, 4001); return; }
    client.device = device;
    send(client, { type: 'ready' });
    return;
  }
  if (!client.device) { close(client, 4001); return; }
  if (!stillLinked(client.device)) { close(client, 4003); return; }
  limit('socket:' + client.device.id, 1200);
  if (message.type === 'pulse') {
    const input = message.pulse || {};
    updateDeviceNickname(client.device, input);
    send(client, { type: 'pulse', ...pulse(client.device, input) });
    // A device's new state goes straight to the devices controlling it.
    notifyGroup(client.device);
    return;
  }
  if (message.type === 'command') {
    try {
      sendCommand(client.device, message.command || {});
      send(client, { type: 'commandResult', requestId: message.requestId });
      for (const target of sockets) if (target.device?.id === message.command.target) send(target, { type: 'pulse', ...connectView(target.device) });
    } catch (error) {
      send(client, { type: 'commandResult', requestId: message.requestId, error: error.status ? error.message : 'Remote command failed' });
    }
  }
}
function receive(client, chunk) {
  client.alive = true;
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const data = client.buffer;
    const fin = data[0] & 0x80, opcode = data[0] & 0x0f, masked = data[1] & 0x80;
    let length = data[1] & 0x7f, offset = 2;
    if (length === 126) { if (data.length < 4) return; length = data.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (data.length < 10) return; const big = data.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) { close(client, 1009); return; } length = Number(big); offset = 10; }
    if (!masked || length > MAX_MESSAGE) { close(client, masked ? 1009 : 1002); return; }
    if (data.length < offset + 4 + length) return;
    const mask = data.subarray(offset, offset + 4);
    const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    client.buffer = data.subarray(offset + 4 + length);
    if (opcode === 8) { close(client); return; }
    if (opcode === 9) { client.socket.write(frame(10, payload)); continue; }
    if (opcode === 10) { client.alive = true; continue; }
    // Apps send whole JSON messages; fragmented frames are not used.
    if (opcode !== 1 || !fin) { close(client, 1003); return; }
    let message;
    try { message = JSON.parse(payload.toString('utf8')); } catch { close(client, 1007); return; }
    try { handle(client, message); } catch (error) { send(client, { type: 'error', message: error.status ? error.message : 'Request failed' }); }
  }
}
export function acceptSocket(req, socket, basePath) {
  const path = new URL(req.url, 'http://localhost').pathname;
  const key = req.headers['sec-websocket-key'];
  if (path !== basePath + '/v1/connect/socket' || req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || sockets.size >= 512) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setTimeout(0);
  const client = { socket, buffer: Buffer.alloc(0), device: null, alive: true, closed: false };
  sockets.add(client);
  load.socket(1);
  // Unauthenticated sockets get five seconds; signed-in ones are pinged so
  // proxies keep them open and dead ones are dropped.
  setTimeout(() => { if (!client.device) close(client, 4001); }, 5000).unref();
  client.ping = setInterval(() => {
    if (!client.alive) { close(client, 1001); return; }
    client.alive = false;
    if (!socket.destroyed) socket.write(frame(9));
  }, 25000);
  client.ping.unref();
  socket.on('data', chunk => receive(client, chunk));
  socket.on('error', () => close(client));
  socket.on('close', () => { client.closed = true; if (sockets.delete(client)) load.socket(-1); clearInterval(client.ping); });
}
export function closeSockets() { for (const client of [...sockets]) close(client, 1001); }
