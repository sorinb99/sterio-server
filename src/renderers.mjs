import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { db, hash, getSetting, setSetting } from './db.mjs';
import { HttpError, limit, streamTicket } from './auth.mjs';
import { getTrack, trackView } from './library.mjs';
import { recordPlayback } from './reporting.mjs';
import { prepareDelivery, resolveDelivery } from './delivery.mjs';
import { cast, castName, castPortOpen } from './cast.mjs';
// Network streamers (BluOS players, UPnP/DLNA renderers, Google Cast devices) play straight from
// this server. The server keeps the queue and advances it, so the app is only
// a remote: it can sleep or close while the streamer keeps playing.
db.exec(`CREATE TABLE IF NOT EXISTS renderers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', location TEXT NOT NULL, control TEXT NOT NULL DEFAULT '{}', stream_base TEXT NOT NULL, created INTEGER NOT NULL)`);
// Each streamer belongs to the app device that added it: listeners on other
// networks never see (or control) it. '' marks streamers added in the admin,
// which only the admin lists.
try { db.exec("ALTER TABLE renderers ADD COLUMN owner TEXT NOT NULL DEFAULT ''"); } catch {}
const sessions = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const unescape = value => value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(m,n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(m,n) => String.fromCodePoint(parseInt(n,16))).replace(/&amp;/g,'&');
const escape = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const tag = (xml, name) => { const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`)); return match ? unescape(match[1]).trim() : ''; };
const attribute = (element, name) => { const match = element.match(new RegExp(`\\s${name}="([^"]*)"`)); return match ? unescape(match[1]) : ''; };
const privateHost = host => /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(host) || /^[a-z0-9-]+\.local$/i.test(host);
const clock = seconds => { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; };
const seconds = value => { const match = String(value || '').match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/); return match ? Number(match[1])*3600 + Number(match[2])*60 + Number(match[3]) : 0; };
// Each format's usual MIME spellings; the renderer's own (from GetProtocolInfo) wins.
const mimes = { flac:['audio/flac','audio/x-flac'], dsf:['audio/dsf','audio/x-dsf','audio/dsd','audio/x-dsd'], dff:['audio/dff','audio/x-dff','audio/dsd','audio/x-dsd'], mp3:['audio/mpeg','audio/mp3'], m4a:['audio/mp4','audio/x-m4a','audio/m4a'], aac:['audio/aac','audio/mp4'], alac:['audio/mp4','audio/x-m4a'], wav:['audio/wav','audio/x-wav','audio/wave'], aif:['audio/aiff','audio/x-aiff'], aiff:['audio/aiff','audio/x-aiff'] };
const extensions = { flac:'flac', dsf:'dsf', dff:'dff', dsdiff:'dff', mp3:'mp3', m4a:'m4a', aac:'m4a', alac:'m4a', wav:'wav', aif:'aif', aiff:'aiff' };
// Rate, bit depth and channels on <res>: streamers that show the format read
// them with the MIME type (an Eversolo T8 showed a FLAC as "PCM").
const resAudio = ({ format = {}, dsd }) => (format.sampleRate ? ` sampleFrequency="${Math.round(format.sampleRate)}"` : '') + (format.bitDepth && !dsd ? ` bitsPerSample="${format.bitDepth}"` : '') + (format.channels ? ` nrAudioChannels="${format.channels}"` : '');
const mimeFor = (format, sink = []) => { const names = mimes[String(format.container || format.codec).toLowerCase()] || mimes.flac; return names.find(name => sink.includes(name)) || names[0]; };
// Streamers live on the LAN only: the server never contacts public hosts for them.
function lanUrl(value) {
  let url; try { url = new URL(value); } catch { throw new HttpError(400,'Invalid streamer address'); }
  if (url.protocol !== 'http:' || !privateHost(url.hostname)) throw new HttpError(400,'Streamers must be on the local network (http://192.168.x.x or .local)');
  return url;
}
async function request(url, { method = 'GET', headers = {}, body, timeout = 5000 } = {}) {
  lanUrl(url);
  let response;
  try { response = await fetch(url, { method, headers, body, signal:AbortSignal.timeout(timeout), redirect:'error' }); }
  catch { throw new HttpError(502,'The streamer is unreachable'); }
  const text = await response.text();
  if (text.length > 1048576) throw new HttpError(502,'The streamer sent an oversized response');
  return { status:response.status, text };
}
const bluos = {
  async probe(host) {
    const answer = await request(`http://${host}:11000/SyncStatus`, { timeout:3000 }).catch(() => null);
    const head = answer?.status === 200 && answer.text.match(/<SyncStatus[^>]*>/)?.[0];
    if (!head) return null;
    return { kind:'bluos', name:attribute(head,'name') || 'BluOS player', model:[attribute(head,'brand'), attribute(head,'modelName')].filter(Boolean).join(' '), location:`http://${host}:11000`, control:{ dsd:false } };
  },
  async send(renderer, path) {
    const answer = await request(renderer.location + path);
    if (answer.status !== 200) throw new HttpError(502,`${renderer.name} rejected the command`);
    return answer.text;
  },
  load(renderer, item) { return bluos.send(renderer, '/Play?url=' + encodeURIComponent(item.url)); },
  pause(renderer) { return bluos.send(renderer, '/Pause'); },
  resume(renderer) { return bluos.send(renderer, '/Play'); },
  stop(renderer) { return bluos.send(renderer, '/Stop'); },
  seek(renderer, position) { return bluos.send(renderer, '/Play?seek=' + Math.floor(position)); },
  volume(renderer, level) { return bluos.send(renderer, '/Volume?level=' + Math.round(level)); },
  async status(renderer) {
    const xml = await bluos.send(renderer, '/Status');
    const state = { play:'playing', stream:'playing', pause:'paused', stop:'stopped', connecting:'buffering' }[tag(xml,'state')] || 'stopped';
    // -1: fixed output level, set on the amplifier.
    const volume = Number(tag(xml,'volume'));
    return { state, position:Number(tag(xml,'secs')) || 0, duration:Number(tag(xml,'totlen')) || 0, volume:Number.isFinite(volume) && volume >= 0 ? volume : null, uri:tag(xml,'streamUrl') || null };
  },
};
async function locate(host) {
  // Unicast M-SEARCH: works from a Docker bridge, where multicast does not.
  return await new Promise(resolve => {
    const socket = dgram.createSocket('udp4'); let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.close(); resolve(value); };
    const timer = setTimeout(() => finish(null), 2500);
    socket.on('message', message => { const location = String(message).match(/^location:\s*(\S+)/im)?.[1]; if (location) finish(location); });
    socket.on('error', () => finish(null));
    socket.send(`M-SEARCH * HTTP/1.1\r\nHOST: ${host}:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n`, 1900, host);
  });
}
const upnp = {
  async probe(address) {
    const location = /^http:\/\//.test(address) ? address : await locate(address);
    if (!location) return null;
    const base = lanUrl(location);
    const description = await request(location, { timeout:4000 }).catch(() => null);
    if (description?.status !== 200 || !/MediaRenderer/.test(description.text)) return null;
    const urlBase = tag(description.text,'URLBase') || location;
    const service = type => {
      const block = (description.text.match(/<service>[\s\S]*?<\/service>/g) || []).find(item => item.includes(`:service:${type}:`));
      if (!block) return null;
      const url = new URL(tag(block,'controlURL'), urlBase);
      // Control URLs stay on the device that answered.
      if (url.hostname !== base.hostname) return null;
      return { url:url.href, type:tag(block,'serviceType'), scpd:new URL(tag(block,'SCPDURL'), urlBase).href };
    };
    const avt = service('AVTransport'), rc = service('RenderingControl'), cm = service('ConnectionManager');
    if (!avt) return null;
    const scpd = await request(avt.scpd).catch(() => null);
    const renderer = { name:tag(description.text,'friendlyName') || 'UPnP renderer', location, control:{ avt, rc, cm, next:Boolean(scpd?.text.includes('SetNextAVTransportURI')), dsd:false } };
    if (cm) {
      const sink = tag(await upnp.soap(renderer, cm, 'GetProtocolInfo', {}).catch(() => ''), 'Sink');
      const types = [...new Set(sink.split(',').map(entry => entry.trim().split(':')[2]?.toLowerCase()).filter(type => type?.startsWith('audio/')))].slice(0,80);
      renderer.control.sink = types;
      renderer.control.dsd = types.some(type => /^audio\/(x-)?(dsd|dsf|dff)$/.test(type));
    }
    const model = [tag(description.text,'manufacturer'), tag(description.text,'modelName')].filter(Boolean).join(' ');
    console.log(`Streamer found: ${renderer.name} (${model || 'UPnP'}), gapless=${renderer.control.next}, volume=${Boolean(renderer.control.rc)}, formats: ${(renderer.control.sink || []).join(' ') || 'not reported'}`);
    return { kind:'upnp', model, ...renderer };
  },
  async soap(renderer, service, action, args) {
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${Object.entries(args).map(([key,value]) => `<${key}>${escape(value)}</${key}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
    const answer = await request(service.url, { method:'POST', body, headers:{ 'Content-Type':'text/xml; charset="utf-8"', SOAPAction:`"${service.type}#${action}"` } });
    // Refusals are logged for streamer tests; stream URLs (tickets) never are.
    if (answer.status !== 200 && action !== 'GetVolume') console.warn(`Streamer ${renderer.name} refused ${action}: HTTP ${answer.status} ${tag(answer.text,'errorCode')} ${tag(answer.text,'errorDescription')}`.trim());
    if (answer.status !== 200) throw new HttpError(502,`${renderer.name}: ${tag(answer.text,'errorDescription') || action + ' failed'}`);
    return answer.text;
  },
  didl(item) {
    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/"><item id="${escape(item.id)}" parentID="0" restricted="1"><dc:title>${escape(item.title)}</dc:title><upnp:artist>${escape(item.artist)}</upnp:artist><dc:creator>${escape(item.artist)}</dc:creator><upnp:album>${escape(item.album)}</upnp:album>${item.art ? `<upnp:albumArtURI dlna:profileID="JPEG_TN">${escape(item.art)}</upnp:albumArtURI>` : ''}<upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:${item.mime}:${item.dsd ? '*' : 'DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000'}" duration="${clock(item.duration)}.000"${resAudio(item)}>${escape(item.url)}</res></item></DIDL-Lite>`;
  },
  async load(renderer, item) {
    const uri = { InstanceID:0, CurrentURI:item.url, CurrentURIMetaData:upnp.didl(item) };
    // Some renderers refuse a new URI while playing: stop and try again once.
    try { await upnp.soap(renderer, renderer.control.avt, 'SetAVTransportURI', uri); }
    catch { await upnp.soap(renderer, renderer.control.avt, 'Stop', { InstanceID:0 }).catch(() => {}); await upnp.soap(renderer, renderer.control.avt, 'SetAVTransportURI', uri); }
    // Play can fail while the renderer is still opening the URI (error 701).
    for (let attempt = 0; ; attempt++) {
      try { await upnp.soap(renderer, renderer.control.avt, 'Play', { InstanceID:0, Speed:1 }); return; }
      catch (error) { if (attempt >= 4) throw error; await sleep(400); }
    }
  },
  setNext(renderer, item) { return upnp.soap(renderer, renderer.control.avt, 'SetNextAVTransportURI', { InstanceID:0, NextURI:item.url, NextURIMetaData:upnp.didl(item) }); },
  pause(renderer) { return upnp.soap(renderer, renderer.control.avt, 'Pause', { InstanceID:0 }); },
  resume(renderer) { return upnp.soap(renderer, renderer.control.avt, 'Play', { InstanceID:0, Speed:1 }); },
  stop(renderer) { return upnp.soap(renderer, renderer.control.avt, 'Stop', { InstanceID:0 }); },
  seek(renderer, position) { return upnp.soap(renderer, renderer.control.avt, 'Seek', { InstanceID:0, Unit:'REL_TIME', Target:clock(position) }); },
  volume(renderer, level) {
    if (!renderer.control.rc) throw new HttpError(409,`${renderer.name} has no volume control`);
    return upnp.soap(renderer, renderer.control.rc, 'SetVolume', { InstanceID:0, Channel:'Master', DesiredVolume:Math.round(level) });
  },
  async status(renderer) {
    const transport = tag(await upnp.soap(renderer, renderer.control.avt, 'GetTransportInfo', { InstanceID:0 }), 'CurrentTransportState');
    const position = await upnp.soap(renderer, renderer.control.avt, 'GetPositionInfo', { InstanceID:0 });
    const volume = renderer.control.rc ? Number(tag(await upnp.soap(renderer, renderer.control.rc, 'GetVolume', { InstanceID:0, Channel:'Master' }).catch(() => ''), 'CurrentVolume')) : NaN;
    const state = { PLAYING:'playing', PAUSED_PLAYBACK:'paused', TRANSITIONING:'buffering' }[transport] || 'stopped';
    return { state, position:seconds(tag(position,'RelTime')), duration:seconds(tag(position,'TrackDuration')), volume:Number.isFinite(volume) ? volume : null, uri:tag(position,'TrackURI') || null };
  },
};
const drivers = { bluos, upnp, cast };
const parse = row => row && { ...row, control:JSON.parse(row.control) };
const rendererRow = id => parse(db.prepare('SELECT * FROM renderers WHERE id=?').get(id));
// owner: the app device asking, or undefined for the admin.
function ownedRow(id, owner) {
  const renderer = rendererRow(id);
  if (!renderer || (owner !== undefined && renderer.owner !== owner)) throw new HttpError(404,'Streamer not found');
  return renderer;
}
// Each streamer is a device of its own: stream tickets, rate limits and the
// admin's live playback treat it like any other listener.
const deviceId = id => hash('renderer\0' + id);
const deviceFor = renderer => ({ id:deviceId(renderer.id), name:renderer.name });
// The server's LAN, remembered from any local address it is reached on (the
// admin, an app on the LAN, or the client address a reverse proxy forwards),
// so a search still knows where to look when the app uses a public domain.
let lanHint = getSetting('lanHint') || '', serverBase = getSetting('serverBase') || '';
// apiPort: the admin listener passes the app port, which streamers use.
// The server's own LAN address as apps on the LAN reached it (http://192.168.x.y:7766).
export const lanServerBase = () => serverBase;
export function noteLan(req, apiPort) {
  const host = String(req.headers.host || '').replace(/:\d+$/,'');
  if (privateHost(host) && /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const base = apiPort ? `http://${host}:${apiPort}` : `${config.tlsCert ? 'https' : 'http'}://${req.headers.host}`;
    if (base !== serverBase) { serverBase = base; setSetting('serverBase', base); }
  }
  const forwarded = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  // 172.16/12 is left out for clients: it is usually Docker's own network.
  const value = [host, forwarded].find(item => /^(10\.\d+|192\.168)\.\d+\.\d+$/.test(item) || item === host && /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(item));
  if (value && value !== lanHint) { lanHint = value; setSetting('lanHint', value); }
}
// The streamer fetches from the address the app used on the LAN (or RENDERER_BASE_URL).
export function streamBase(req) {
  if (config.rendererBase) return config.rendererBase.replace(/\/$/,'');
  const host = String(req.headers.host || '');
  const name = host.replace(/:\d+$/,'').replace(/^\[|\]$/g,'');
  if (privateHost(name)) return `${config.tlsCert ? 'https' : 'http'}://${host}`;
  // Reached through a public domain: the LAN address seen earlier, else that
  // domain itself (the streamer then needs internet access back to it).
  if (serverBase) return serverBase;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto === 'http' ? 'http' : 'https'}://${host}` : null;
}
let queueVersion = 0;
function view(renderer, withQueue = false) {
  const session = sessions.get(renderer.id);
  const track = session && getTrack(session.queue[session.index]);
  return { id:renderer.id, kind:renderer.kind, name:renderer.name, model:renderer.model, address:new URL(renderer.location).hostname, streamBase:renderer.stream_base, dsd:renderer.control.dsd === true, gapless:renderer.kind === 'upnp' && renderer.control.next === true,
    session:session ? { trackIds:session.queue, index:session.index, status:session.status, position:session.position, duration:session.duration, volume:session.volume, error:session.error, online:session.failures < 3, controller:session.controller, track:track ? trackView(track,new Set()) : null, format:session.current?.format || null, queueVersion:session.version,
      ...(withQueue ? { tracks:session.queue.map(id => getTrack(id)).filter(Boolean).map(item => trackView(item,new Set())) } : {}) } : null };
}
// queue: a streamer whose full queue the app needs (it changes only on play).
// owner: the app device; undefined (the admin) lists every streamer.
export function listRenderers(queue, owner) {
  const rows = owner === undefined ? db.prepare('SELECT * FROM renderers ORDER BY name').all() : db.prepare('SELECT * FROM renderers WHERE owner=? ORDER BY name').all(owner);
  return { items:rows.map(row => view(parse(row), row.id === queue)) };
}
// base: where the streamer fetches audio. Unknown yet (admin on localhost): the
// first playback from the app on the LAN sets it.
export async function addRenderer(input, base, owner = '') {
  const address = String(input.address || '').trim();
  const host = address.replace(/^http:\/\//,'').replace(/[:/].*$/,'');
  if (!privateHost(host)) throw new HttpError(400,'Enter the streamer\'s local IP address, for example 192.168.1.50');
  // kind 'cast' (from a search) goes straight to Google Cast; a typed address
  // tries BluOS, UPnP, then Cast.
  const found = input.kind === 'cast' || /:8009$/.test(address) ? await cast.probe(host)
    : (!/^http:\/\//.test(address) && await bluos.probe(host)) || await upnp.probe(/^http:\/\//.test(address) ? address : host) || (!/^http:\/\//.test(address) && await cast.probe(host));
  if (!found) throw new HttpError(404,'No BluOS, UPnP or Google Cast streamer answered at this address');
  // The same streamer at a new address (a UPnP renderer takes a new port when
  // it restarts) updates the entry instead of adding a second one.
  const foundHost = new URL(found.location).hostname;
  const existing = db.prepare('SELECT id FROM renderers WHERE location=? AND owner=?').get(found.location, owner)
    || db.prepare('SELECT id, location, name, kind FROM renderers WHERE owner=?').all(owner).find(row => row.kind === found.kind && row.name.trim().toLowerCase() === found.name.slice(0,80).trim().toLowerCase() && new URL(row.location).hostname === foundHost);
  const id = existing?.id || randomUUID();
  db.prepare(`INSERT INTO renderers (id,kind,name,model,location,control,stream_base,created,owner) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,model=excluded.model,location=excluded.location,control=excluded.control,stream_base=CASE WHEN excluded.stream_base<>'' THEN excluded.stream_base ELSE renderers.stream_base END`)
    .run(id, found.kind, found.name.slice(0,80), found.model.slice(0,120), found.location, JSON.stringify(found.control), base || '', Date.now(), owner);
  // A session keeps playing on the updated address.
  const session = sessions.get(id); if (session) session.renderer = rendererRow(id);
  const label = `${found.name.slice(0,60)} (streamer)`;
  db.prepare("INSERT INTO devices (id,name,public_key,created) VALUES (?,?,'',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(deviceId(id), label, Date.now());
  return view(rendererRow(id));
}
export async function removeRenderer(id, owner) {
  const renderer = ownedRow(id, owner);
  const session = sessions.get(id);
  if (session) { session.epoch++; report(session,'stop'); sessions.delete(id); await drivers[renderer.kind].stop(renderer).catch(() => {}); }
  db.prepare('DELETE FROM renderers WHERE id=?').run(id);
  db.prepare('DELETE FROM devices WHERE id=?').run(deviceId(id));
  return { ok:true };
}
// Searches the server's /24 (from the address the app or admin used): BluOS on
// port 11000, a unicast SSDP search on port 1900 to every address, which
// also works from a Docker bridge network, plus the usual multicast search,
// and Google Cast's port 8009 (mDNS does not cross a Docker bridge either).
export async function discoverRenderers(subnet, owner) {
  const found = new Map(), players = [];
  // An app on the public address: use the LAN address streamers already use.
  const lan = [subnet, config.rendererBase, lanHint, ...db.prepare("SELECT stream_base FROM renderers WHERE stream_base<>''").all().map(row => row.stream_base)]
    .map(value => String(value || '').replace(/^https?:\/\//,'').replace(/[:/].*$/,'')).find(value => /^\d+\.\d+\.\d+\.\d+$/.test(value) && privateHost(value));
  const prefix = /^(\d+\.\d+\.\d+)\.\d+$/.exec(lan || '')?.[1];
  const hosts = prefix && privateHost(prefix + '.1') ? Array.from({ length:254 }, (_, i) => `${prefix}.${i + 1}`) : [];
  const bluosScan = (async () => {
    for (let i = 0; i < hosts.length; i += 64) {
      await Promise.all(hosts.slice(i, i + 64).map(async host => {
        const player = await request(`http://${host}:11000/SyncStatus`, { timeout:1200 }).catch(() => null);
        const head = player?.status === 200 && player.text.match(/<SyncStatus[^>]*>/)?.[0];
        if (head) players.push({ address:host, location:`http://${host}:11000`, name:attribute(head,'name') || 'BluOS player', kind:'bluos' });
      }));
    }
  })();
  const ssdp = new Promise(resolve => {
    const socket = dgram.createSocket({ type:'udp4', reuseAddr:true });
    const finish = () => { try { socket.close(); } catch {} resolve(); };
    socket.on('error', finish);
    socket.on('message', (message, from) => { const location = String(message).match(/^location:\s*(\S+)/im)?.[1]; if (location && privateHost(from.address)) found.set(location, from.address); });
    socket.bind(() => {
      const search = target => `M-SEARCH * HTTP/1.1\r\nHOST: ${target}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n`;
      try { socket.setMulticastTTL(2); socket.send(search('239.255.255.250'), 1900, '239.255.255.250'); } catch {}
      for (const host of hosts) socket.send(search(host), 1900, host, () => {});
    });
    setTimeout(finish, 3500);
  });
  const castHosts = [];
  const castScan = (async () => {
    for (let i = 0; i < hosts.length; i += 64) await Promise.all(hosts.slice(i, i + 64).map(async host => { if (await castPortOpen(host)) castHosts.push(host); }));
  })();
  await Promise.all([bluosScan, ssdp, castScan]);
  const known = new Set((owner === undefined ? db.prepare('SELECT location FROM renderers').all() : db.prepare('SELECT location FROM renderers WHERE owner=?').all(owner)).map(row => row.location));
  const upnpFound = [];
  for (const [location, address] of found) {
    if (known.has(location)) continue;
    const description = await request(location, { timeout:2000 }).catch(() => null);
    if (description?.status === 200 && /MediaRenderer/.test(description.text)) upnpFound.push({ address, location, name:tag(description.text,'friendlyName') || address, kind:'upnp' });
  }
  // A speaker with UPnP or BluOS as well is listed once, by those (gapless, DSD).
  const taken = new Set([...players.map(item => item.address), ...upnpFound.map(item => item.address), ...[...found.values()]]);
  const casts = await Promise.all(castHosts.filter(host => !taken.has(host) && !known.has(`http://${host}:8009`)).map(async host => ({ address:host, location:`http://${host}:8009`, name:(await castName(host)).name, kind:'cast' })));
  return { items:[...players.filter(item => !known.has(item.location)), ...upnpFound, ...casts] };
}
function report(session, kind) {
  const trackId = session.queue[session.index];
  if (!getTrack(trackId)) return;
  try { recordPlayback(deviceFor(session.renderer), { trackId, kind, position:Math.min(session.position,604800), status:session.status === 'paused' ? 'paused' : 'playing', route:session.renderer.name, platform:'streamer' }); } catch {}
  session.reported = Date.now();
}
// Resolves the track exactly like an app would, with conversion where the
// streamer cannot play the original (DSD without DSD support, CUE chapters).
// live: a linked DSD track can start while it converts (see media.mjs).
const deliveryInput = (track, control) => ({ delivery:track.dsd && !control.dsd ? 'pcm' : 'original', allowConversion:true, allowDsdToPcm:true, cueDelivery:'flac-track-v1', live:true });
async function resolveFor(device, track, control) {
  const resolved = await resolveDelivery(device, track, deliveryInput(track, control));
  if (resolved.status !== 200) throw new HttpError(502, resolved.body?.error || 'This track cannot be delivered to the streamer');
  return resolved.body;
}
function itemFor(device, track, value, control, base) {
  const segment = value.segment && Number.isFinite(value.segment.startSeconds) ? value.segment : null;
  const format = value.deliveredFormat || track.format;
  // Streamers (Eversolo, for one) name the format from the file extension:
  // without it a FLAC shows as PCM. The stream route accepts and ignores it.
  const art = track.albumId ? `${base}${config.basePath}/v1/images/${track.albumId}.jpg?width=600&ticket=${streamTicket(track.albumId, device.id, 'original')}` : '';
  const extension = extensions[String(format.container || format.codec).toLowerCase()] || 'flac';
  return { url:base + value.path.replace('?', `.${extension}?`), stream:value.path.split('?')[0], segment, format, id:track.id, title:track.title, artist:track.artist, album:track.album, art, mime:mimeFor(format, control.sink), dsd:/^(dsf|dff)$/i.test(String(format.container)),
    duration:segment ? (segment.endSeconds || track.durationMs / 1000) - segment.startSeconds : (track.durationMs || 0) / 1000 };
}
async function deliver(session, index, epoch) {
  const track = getTrack(session.queue[index]); if (!track) throw new HttpError(404,'Track not found');
  const renderer = session.renderer, device = deviceFor(renderer);
  if (!renderer.stream_base) throw new HttpError(409,'Start playback from the app while it is connected to the server\'s local address, so the streamer knows where to fetch audio.');
  const value = await resolveFor(device, track, renderer.control);
  if (value.mode !== 'original') {
    for (const started = Date.now(); ;) {
      if (epoch !== session.epoch) return null;
      const ready = await prepareDelivery(track, deliveryInput(track, renderer.control));
      if (ready.body?.ready) break;
      if (Date.now() - started > 30 * 60000) throw new HttpError(504,'The server conversion took too long');
      await sleep(Math.max(200, Math.min(5000, ready.body?.retryAfterMs || 1000)));
    }
  }
  return { index, ...itemFor(device, track, value, renderer.control, renderer.stream_base) };
}
// A streamer the server cannot reach (on the listener's own network, another
// site): the app controls it and asks here for each track's public stream URL.
// Tickets belong to the app's device and last a day.
export async function externalItem(device, input, base) {
  limit('renderer-item:' + device.id, 600);
  if (!base) throw new HttpError(409,'The server address is unknown');
  const track = typeof input.trackId === 'string' && /^[a-f0-9]{64}$/.test(input.trackId) && getTrack(input.trackId);
  if (!track) throw new HttpError(404,'Track not found');
  const control = { dsd:input.dsd === true, sink:Array.isArray(input.sink) ? input.sink.filter(item => typeof item === 'string' && item.length < 64).slice(0,80) : [] };
  const value = await resolveFor(device, track, control);
  // Converted tracks: the app asks again until the server has them ready.
  const prepared = value.mode === 'original' ? null : await prepareDelivery(track, deliveryInput(track, control));
  return { ready:!prepared || prepared.body?.ready === true, retryAfterMs:prepared?.body?.retryAfterMs || 0, item:itemFor(device, track, value, control, base) };
}
// The address a streamer on another network uses: the one this request came to.
export function publicBase(req) {
  const host = String(req.headers.host || '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return `${privateHost(host.replace(/:\d+$/,'')) ? (config.tlsCert ? 'https' : 'http') : proto === 'http' ? 'http' : 'https'}://${host}`;
}
async function start(session, offset = 0) {
  const epoch = ++session.epoch, renderer = session.renderer, driver = drivers[renderer.kind];
  Object.assign(session, { status:'buffering', error:null, position:offset, next:null, loadedAt:Date.now(), pendingSeek:null });
  try {
    const item = await deliver(session, session.index, epoch);
    if (!item || epoch !== session.epoch) return;
    session.current = item; session.duration = item.duration;
    await driver.load(renderer, item);
    if (epoch !== session.epoch) return;
    session.loadedAt = Date.now();
    const target = (item.segment?.startSeconds || 0) + offset;
    // Seeking works once the streamer is playing; the poll applies it.
    if (target > 0.5) session.pendingSeek = target;
    report(session,'start');
    void queueNext(session, epoch);
  } catch (error) {
    if (epoch === session.epoch) { session.status = 'error'; session.error = error.message; }
  }
}
// UPnP renderers with SetNextAVTransportURI play the next track gaplessly.
async function queueNext(session, epoch) {
  const renderer = session.renderer;
  if (renderer.kind !== 'upnp' || !renderer.control.next || session.index + 1 >= session.queue.length || session.current?.segment) return;
  try {
    const item = await deliver(session, session.index + 1, epoch);
    if (!item || item.segment || epoch !== session.epoch) return;
    await upnp.setNext(renderer, item);
    if (epoch === session.epoch) session.next = item;
  } catch {}
}
async function advance(session, delta) {
  report(session,'stop');
  const index = session.index + delta;
  if (index >= 0 && index < session.queue.length) { session.index = index; await start(session); return; }
  session.epoch++; session.status = 'ended'; session.position = 0;
}
async function poll(session) {
  if (session.polling) return;
  session.polling = true;
  const epoch = session.epoch, renderer = session.renderer, driver = drivers[renderer.kind];
  try {
    const state = await driver.status(renderer);
    session.failures = 0;
    if (epoch !== session.epoch) return;
    session.volume = state.volume;
    // The renderer moved to the queued next track on its own.
    if (session.next && state.uri && (state.uri === session.next.url || state.uri.includes(session.next.stream) && !state.uri.includes(session.current?.stream))) {
      report(session,'stop');
      session.index = session.next.index; session.current = session.next; session.duration = session.next.duration; session.next = null;
      session.position = state.position; report(session,'start');
      void queueNext(session, epoch);
    }
    // Another app started something else on the streamer: let it go.
    const ours = item => item && state.uri.includes(item.stream);
    if (state.uri && state.state === 'playing' && Date.now() - session.loadedAt > 10000 && session.current && !ours(session.current) && !ours(session.next)) {
      report(session,'stop'); session.epoch++; session.status = 'stopped'; session.error = null; return;
    }
    if (state.state === 'playing' && session.pendingSeek !== null) { const target = session.pendingSeek; session.pendingSeek = null; await driver.seek(renderer, target); return; }
    const offset = session.current?.segment?.startSeconds || 0, end = session.current?.segment?.endSeconds;
    const position = Math.max(0, state.position - offset);
    if (state.state === 'playing') {
      session.status = 'playing'; session.position = position;
      if (!session.current?.segment && state.duration > 0) session.duration = state.duration;
      if (end && state.position >= end - 0.3) return await advance(session, 1);
    } else if (state.state === 'paused') { session.status = 'paused'; session.position = position; }
    else if (state.state === 'stopped' && Date.now() - session.loadedAt > 10000 && session.status === 'playing') {
      // Stopped at the end: the next track. Stopped earlier: someone stopped the streamer.
      if (session.duration > 0 && session.position >= session.duration - 4) return await advance(session, 1);
      report(session,'stop'); session.status = 'stopped';
    } else if (state.state === 'stopped' && session.status === 'buffering' && Date.now() - session.loadedAt > 30000) {
      session.epoch++; session.status = 'error'; session.error = `${renderer.name} did not start playback. It may not support this format.`;
    }
    if (['playing','paused'].includes(session.status) && Date.now() - (session.reported || 0) > 5000) report(session,'progress');
  } catch (error) {
    session.failures = (session.failures || 0) + 1;
    if (session.failures >= 30 && epoch === session.epoch) { session.epoch++; session.status = 'error'; session.error = 'The streamer stopped responding'; }
  } finally { session.polling = false; }
}
// Every second while audio moves; a paused streamer is checked every 10 s.
setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!['playing','paused','buffering'].includes(session.status)) continue;
    if (session.status === 'paused' && now - (session.polledAt || 0) < 10000) continue;
    session.polledAt = now; void poll(session);
  }
}, 1000).unref();
function queueIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 500 || value.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !getTrack(id))) throw new HttpError(400,'Invalid playback queue (1 to 500 tracks)');
  return value;
}
export async function playOnRenderer(device, id, input, base) {
  limit('renderer:' + device.id, 120);
  ownedRow(id, device.id);
  // Follow the server address the app currently uses on the LAN.
  if (base) db.prepare('UPDATE renderers SET stream_base=? WHERE id=?').run(base, id);
  const renderer = rendererRow(id);
  const queue = queueIds(input.trackIds);
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= queue.length) throw new HttpError(400,'Invalid track index');
  const previous = sessions.get(id);
  if (previous) { previous.epoch++; report(previous,'stop'); }
  const session = { renderer, queue, index:input.index, version:++queueVersion, epoch:0, status:'buffering', position:0, duration:0, volume:previous?.volume ?? null, failures:0, controller:device.name, current:null, next:null, pendingSeek:null };
  sessions.set(id, session);
  const offset = Number.isFinite(input.position) && input.position > 0 && input.position < 604800 ? input.position : 0;
  await start(session, offset);
  return view(renderer);
}
// admin: the admin's commands reach every streamer.
export async function controlRenderer(device, id, input, admin = false) {
  limit('renderer:' + device.id, 240);
  const renderer = ownedRow(id, admin ? undefined : device.id);
  const session = sessions.get(id), driver = drivers[renderer.kind];
  if (input.action === 'volume') {
    if (!Number.isFinite(input.volume) || input.volume < 0 || input.volume > 100) throw new HttpError(400,'Volume must be between 0 and 100');
    await driver.volume(renderer, input.volume); if (session) session.volume = Math.round(input.volume);
    return view(renderer);
  }
  if (!session) throw new HttpError(409,'Nothing is playing on this streamer');
  session.controller = device.name;
  const offset = session.current?.segment?.startSeconds || 0;
  switch (input.action) {
    case 'pause': await driver.pause(renderer); session.status = 'paused'; break;
    case 'resume':
      if (['ended','stopped','error'].includes(session.status)) { if (session.status === 'ended') session.index = 0; await start(session, session.status === 'stopped' ? session.position : 0); }
      else { await driver.resume(renderer); session.status = 'playing'; }
      break;
    case 'toggle': return await controlRenderer(device, id, { action:session.status === 'playing' || session.status === 'buffering' ? 'pause' : 'resume' }, admin);
    case 'next': if (session.index + 1 < session.queue.length) await advance(session, 1); break;
    case 'previous':
      if (session.position > 3 || session.index === 0) { await driver.seek(renderer, offset); session.position = 0; }
      else await advance(session, -1);
      break;
    case 'seek':
      if (!Number.isFinite(input.position) || input.position < 0 || input.position > 604800) throw new HttpError(400,'Invalid seek position');
      await driver.seek(renderer, offset + input.position); session.position = input.position; break;
    case 'stop': session.epoch++; await driver.stop(renderer).catch(() => {}); report(session,'stop'); session.status = 'stopped'; break;
    default: throw new HttpError(400,'Unknown streamer command');
  }
  return view(renderer);
}
