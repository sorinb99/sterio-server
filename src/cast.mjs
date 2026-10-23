import tls from 'node:tls';
import net from 'node:net';
import https from 'node:https';
// Google Cast (Chromecast built-in speakers: Harman Kardon Citation, Nest,
// Chromecast Audio…). The server talks the Cast v2 protocol itself: a TLS
// connection to port 8009 carrying length-prefixed protobuf messages with JSON
// payloads. It launches Google's Default Media Receiver and gives it the same
// stream URL a UPnP renderer gets. One connection per device, kept while used.
const RECEIVER = 'receiver-0', SENDER = 'sender-sterio';
const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const MEDIA_RECEIVER = 'CC1AD845';
const privateIp = host => /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(host);

// CastMessage: protocol_version=1 (0), source_id=2, destination_id=3,
// namespace=4, payload_type=5 (0: string), payload_utf8=6.
function varint(value) { const bytes = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; bytes.push(byte); } while (value); return Buffer.from(bytes); }
function field(number, text) { const data = Buffer.from(text, 'utf8'); return Buffer.concat([Buffer.from([(number << 3) | 2]), varint(data.length), data]); }
function encode(source, destination, namespace, payload) {
  const body = Buffer.concat([Buffer.from([0x08, 0x00]), field(2, source), field(3, destination), field(4, namespace), Buffer.from([0x28, 0x00]), field(6, JSON.stringify(payload))]);
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}
function decode(buffer) {
  const message = {}; let offset = 0;
  const read = () => { let value = 0, shift = 0, byte; do { byte = buffer[offset++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80 && offset < buffer.length); return value; };
  while (offset < buffer.length) {
    const key = read(), number = key >> 3, type = key & 7;
    if (type === 0) { read(); continue; }
    if (type !== 2) break;
    const length = read(), value = buffer.subarray(offset, offset + length).toString('utf8'); offset += length;
    if (number === 2) message.source = value; else if (number === 3) message.destination = value; else if (number === 4) message.namespace = value; else if (number === 6) message.payload = value;
  }
  return message;
}

const links = new Map();
function close(link) {
  clearInterval(link.heartbeat); clearTimeout(link.idle);
  for (const pending of link.pending.values()) pending.reject(new Error('The Cast device closed the connection'));
  link.pending.clear(); link.socket.destroy();
  if (links.get(link.host) === link) links.delete(link.host);
}
// Connections close after five idle minutes; a playing session polls every second.
function touch(link) { clearTimeout(link.idle); link.idle = setTimeout(() => close(link), 5 * 60000); link.idle.unref?.(); }
function connect(host) {
  if (!privateIp(host)) return Promise.reject(new Error('Cast devices must be on the local network'));
  const existing = links.get(host);
  if (existing && !existing.socket.destroyed) { touch(existing); return existing.ready; }
  const link = { host, pending:new Map(), nextId:1, buffer:Buffer.alloc(0), transport:null, media:null, receiver:null, contentId:null };
  // Cast devices present self-signed certificates; the connection stays on the LAN.
  link.socket = tls.connect({ host, port:8009, rejectUnauthorized:false, timeout:5000 });
  link.ready = new Promise((resolve, reject) => {
    link.socket.once('secureConnect', () => {
      link.socket.setTimeout(0);
      send(link, RECEIVER, NS.connection, { type:'CONNECT' });
      link.heartbeat = setInterval(() => send(link, RECEIVER, NS.heartbeat, { type:'PING' }), 5000); link.heartbeat.unref?.();
      touch(link); resolve(link);
    });
    link.socket.once('timeout', () => { reject(new Error('The Cast device did not answer')); close(link); });
    link.socket.once('error', error => { reject(error); close(link); });
  });
  link.socket.on('close', () => close(link));
  link.socket.on('data', chunk => {
    link.buffer = Buffer.concat([link.buffer, chunk]);
    while (link.buffer.length >= 4) {
      const length = link.buffer.readUInt32BE(0);
      if (length > 65536) { close(link); return; }
      if (link.buffer.length < 4 + length) break;
      const message = decode(link.buffer.subarray(4, 4 + length)); link.buffer = link.buffer.subarray(4 + length);
      let payload; try { payload = JSON.parse(message.payload || '{}'); } catch { continue; }
      receive(link, message, payload);
    }
  });
  links.set(host, link);
  return link.ready;
}
function send(link, destination, namespace, payload) { if (!link.socket.destroyed) link.socket.write(encode(SENDER, destination, namespace, payload)); }
function receive(link, message, payload) {
  if (message.namespace === NS.heartbeat && payload.type === 'PING') return send(link, message.source, NS.heartbeat, { type:'PONG' });
  if (message.namespace === NS.connection && payload.type === 'CLOSE' && message.source === link.transport) { link.transport = null; link.media = null; }
  if (payload.type === 'RECEIVER_STATUS') link.receiver = payload.status;
  if (payload.type === 'MEDIA_STATUS') {
    const status = payload.status?.[0];
    link.media = status || null;
    if (status?.media?.contentId) link.contentId = status.media.contentId;
  }
  const pending = payload.requestId && link.pending.get(payload.requestId);
  if (!pending) return;
  link.pending.delete(payload.requestId); clearTimeout(pending.timer);
  if (/_ERROR$|^LOAD_FAILED$|^LOAD_CANCELLED$|^INVALID_REQUEST$/.test(payload.type)) pending.reject(new Error(`Cast device: ${payload.reason || payload.type}`));
  else pending.resolve(payload);
}
function ask(link, destination, namespace, payload, timeout = 8000) {
  const requestId = link.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { link.pending.delete(requestId); reject(new Error('The Cast device did not answer')); }, timeout);
    link.pending.set(requestId, { resolve, reject, timer });
    send(link, destination, namespace, { ...payload, requestId });
  });
}
const mediaApp = status => status?.applications?.find(app => app.appId === MEDIA_RECEIVER);
// The Default Media Receiver, launched if another app (or none) is running.
async function mediaReceiver(link) {
  let app = mediaApp((await ask(link, RECEIVER, NS.receiver, { type:'GET_STATUS' })).status);
  if (!app) app = mediaApp((await ask(link, RECEIVER, NS.receiver, { type:'LAUNCH', appId:MEDIA_RECEIVER }, 20000)).status);
  if (!app) throw new Error('The Cast device did not start its media player');
  if (link.transport !== app.transportId) { link.transport = app.transportId; link.media = null; send(link, app.transportId, NS.connection, { type:'CONNECT' }); }
  return app.transportId;
}
const host = renderer => new URL(renderer.location).hostname;
async function mediaCommand(renderer, payload) {
  const link = await connect(host(renderer));
  const transport = await mediaReceiver(link);
  if (!link.media?.mediaSessionId) await ask(link, transport, NS.media, { type:'GET_STATUS' }).catch(() => {});
  if (!link.media?.mediaSessionId) throw new Error(`${renderer.name} has nothing loaded`);
  return ask(link, transport, NS.media, { ...payload, mediaSessionId:link.media.mediaSessionId });
}
// The device's name: its setup page on port 8008 (8443 on newer firmware).
async function eureka(address) {
  const path = '/setup/eureka_info?params=name,device_info';
  try {
    const answer = await fetch(`http://${address}:8008${path}`, { signal:AbortSignal.timeout(1500), redirect:'error' });
    if (answer.ok) return await answer.json();
  } catch {}
  return await new Promise(resolve => {
    const request = https.get({ host:address, port:8443, path, rejectUnauthorized:false, timeout:1500 }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', part => { text += part; if (text.length > 65536) request.destroy(); });
      response.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(null); } });
    });
    request.on('error', () => resolve(null)); request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}
// Port 8009 open, without speaking TLS yet: the network search tries 254 hosts.
export function castPortOpen(address, timeout = 1200) {
  return new Promise(resolve => {
    const socket = net.connect({ host:address, port:8009 });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  });
}
export async function castName(address) {
  const info = await eureka(address);
  return { name:String(info?.name || '').slice(0,80) || `Cast device ${address}`, model:[info?.device_info?.manufacturer, info?.device_info?.model_name].filter(Boolean).join(' ').slice(0,120) };
}
export const cast = {
  async probe(address) {
    if (!privateIp(address)) return null;
    try {
      const link = await connect(address);
      await ask(link, RECEIVER, NS.receiver, { type:'GET_STATUS' }, 4000);
    } catch { return null; }
    const { name, model } = await castName(address);
    console.log(`Streamer found: ${name} (${model || 'Google Cast'})`);
    // The Default Media Receiver plays FLAC, ALAC, AAC, MP3 and WAV, not DSD.
    return { kind:'cast', name, model, location:`http://${address}:8009`, control:{ dsd:false, sink:['audio/flac','audio/mp4','audio/aac','audio/mpeg','audio/wav'] } };
  },
  async load(renderer, item) {
    const link = await connect(host(renderer));
    const transport = await mediaReceiver(link);
    link.contentId = item.url;
    await ask(link, transport, NS.media, { type:'LOAD', autoplay:true, currentTime:0, media:{
      contentId:item.url, contentType:item.mime, streamType:'BUFFERED', ...(item.duration ? { duration:item.duration } : {}),
      metadata:{ metadataType:3, title:item.title, artist:item.artist, albumName:item.album, images:item.art ? [{ url:item.art }] : [] } } }, 30000);
  },
  pause(renderer) { return mediaCommand(renderer, { type:'PAUSE' }); },
  resume(renderer) { return mediaCommand(renderer, { type:'PLAY' }); },
  stop(renderer) { return mediaCommand(renderer, { type:'STOP' }); },
  seek(renderer, position) { return mediaCommand(renderer, { type:'SEEK', currentTime:position, resumeState:'PLAYBACK_START' }); },
  async volume(renderer, level) {
    const link = await connect(host(renderer));
    await ask(link, RECEIVER, NS.receiver, { type:'SET_VOLUME', volume:{ level:Math.max(0, Math.min(1, level / 100)) } });
  },
  async status(renderer) {
    const link = await connect(host(renderer));
    const receiver = (await ask(link, RECEIVER, NS.receiver, { type:'GET_STATUS' }, 4000)).status;
    const level = receiver?.volume?.level, volume = Number.isFinite(level) ? Math.round(level * 100) : null;
    const app = mediaApp(receiver);
    // Another app (YouTube, Spotify…) took the device over.
    if (!app) return { state:receiver?.applications?.length ? 'playing' : 'stopped', position:0, duration:0, volume, uri:receiver?.applications?.length ? 'cast:other-app' : null };
    if (link.transport !== app.transportId) { link.transport = app.transportId; link.media = null; send(link, app.transportId, NS.connection, { type:'CONNECT' }); }
    const media = (await ask(link, app.transportId, NS.media, { type:'GET_STATUS' }, 4000)).status?.[0];
    link.media = media || null;
    if (media?.media?.contentId) link.contentId = media.media.contentId;
    const state = { PLAYING:'playing', PAUSED:'paused', BUFFERING:'buffering' }[media?.playerState] || 'stopped';
    return { state, position:Number(media?.currentTime) || 0, duration:Number(media?.media?.duration) || 0, volume, uri:media ? link.contentId : null };
  },
};
