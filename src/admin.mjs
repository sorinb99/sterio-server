import http from 'node:http';
import { artistTools, mergeArtists, undoMerge, artworkTools, searchArtwork, previewArtwork, applyArtwork, resetArtwork, startArtworkJob, cancelArtworkJob } from './curation.mjs';
import { sendFile } from './media.mjs';
import { livePlayback, latestPlayback, playbackReport, reportCSV, setListener } from './reporting.mjs';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { db, hash, setSetting } from './db.mjs';
import { scanLibrary, scanStatus, scanIntervalMinutes, scanIntervals, setScanInterval, albumViews, groupViews, albumTracks, sacdImages } from './library.mjs';
import { HttpError, limit } from './auth.mjs';
import { splitSummary, startSplit, stopSplit } from './split.mjs';
import { removeDevice, setDeviceAdmin } from './app-admin.mjs';
import { decideRequest, pendingRequests } from './requests.mjs';
import { connectPeer, createShareKey, peerSummary, removePeer, removePeerClient, syncPeer } from './peers.mjs';
import { addRenderer, controlRenderer, discoverRenderers, listRenderers, noteLan, removeRenderer } from './renderers.mjs';
import { allowThroughFirewall, chooseMusicFolder, macStatus } from './mac.mjs';
import { betaExpired, betaExpiresDay } from './license.mjs';
import { setTelemetry, telemetryState } from './telemetry.mjs';
import { updateState } from './updates.mjs';
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
let summaryCache, summaryAt=0;
function librarySummary() {
  if (!summaryCache || Date.now()-summaryAt>15000) {
    summaryCache={tracks:albumTracks(null).length,albums:albumViews().length,artists:groupViews('artists').length}; summaryAt=Date.now();
  }
  return summaryCache;
}
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]].map(([route,[file,type]]) => [route,{data:readFileSync(new URL(`./admin/${file}`,import.meta.url)),type}]));
const json = (res,status,value) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
function localAddress(ip) {
  ip = (ip || '').replace(/^::ffff:/,'');
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (!net.isIPv4(ip)) return false;
  const n = ip.split('.').reduce((a,b) => (a*256+Number(b))>>>0,0);
  return config.adminNetworks.some(cidr => {
    const [address,prefix] = cidr.split('/');
    const bits = Number(prefix);
    if (!net.isIPv4(address) || !Number.isInteger(bits) || bits<8 || bits>32) return false;
    // Only explicitly configured RFC1918 LAN ranges are accepted.
    if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return false;
    if (address.startsWith('192.168.') && bits<16 || address.startsWith('172.') && bits<12) return false;
    const base = address.split('.').reduce((a,b) => (a*256+Number(b))>>>0,0);
    const mask = (0xffffffff << (32-bits))>>>0;
    return (n & mask) === (base & mask);
  });
}
// A rebinding page can only send its own domain as Host, so localhost or a
// private IPv4 address on any port is safe without listing it; names must be
// listed in ADMIN_ALLOWED_HOSTS.
function addressHost(host) {
  const name = host.replace(/:\d{1,5}$/,'');
  return name === 'localhost' || net.isIPv4(name) && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(name);
}
async function input(req) {
  let size=0; const chunks=[];
  for await (const chunk of req) { size+=chunk.length; if(size>4096) throw new HttpError(413,'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400,'Invalid request'); }
}
export function startAdmin() {
  if (!config.adminEnabled) return null;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if(!localAddress(req.socket.remoteAddress)) throw new HttpError(403,'Local network access only');
      // Ignore all forwarding headers: this listener must never trust a proxy.
      const host=req.headers.host || '';
      if(!config.adminHosts.includes(host) && !addressHost(host)) throw new HttpError(403,'Invalid admin host');
      limit('admin:'+req.socket.remoteAddress,180);
      noteLan(req,config.port);
      const route=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET' && assets.has(route)) { const asset=assets.get(route); res.writeHead(200,{'Content-Type':asset.type+'; charset=utf-8'}); return res.end(asset.data); }
      if(req.method==='POST') {
        if(req.headers.origin !== 'http://'+host || !req.headers['content-type']?.startsWith('application/json')) throw new HttpError(403,'Invalid request origin');
      }
      // No account: access is limited to the configured LAN/VPN networks and
      // admin hosts. POSTs need this origin and JSON, which blocks cross-site requests.
      if(req.method==='GET' && route==='/api/artists/tools')return json(res,200,artistTools());
      if(req.method==='POST' && route==='/api/artists/merge'){const result=mergeArtists(await input(req));summaryCache=null;return json(res,200,result);}
      if(req.method==='POST' && route==='/api/artists/undo'){const result=undoMerge(await input(req));summaryCache=null;return json(res,200,result);}
      if(req.method==='GET' && route==='/api/artwork/tools')return json(res,200,artworkTools());
      if(req.method==='POST' && route==='/api/artwork/search')return json(res,200,await searchArtwork(await input(req)));
      if(req.method==='GET' && route==='/api/artwork/preview')return await sendFile(req,res,await previewArtwork(new URL(req.url,'http://localhost').searchParams.get('token')),'image/jpeg');
      if(req.method==='POST' && route==='/api/artwork/apply')return json(res,200,await applyArtwork(await input(req)));
      if(req.method==='POST' && route==='/api/artwork/reset')return json(res,200,resetArtwork(await input(req)));
      if(req.method==='POST' && route==='/api/artwork/start')return json(res,202,startArtworkJob(await input(req)));
      if(req.method==='POST' && route==='/api/artwork/stop')return json(res,200,cancelArtworkJob());
      if(req.method==='GET' && route==='/api/latest') return json(res,200,latestPlayback());
      if(req.method==='GET' && route==='/api/live') return json(res,200,livePlayback());
      if(req.method==='GET' && route==='/api/report') return json(res,200,playbackReport(new URL(req.url,'http://localhost').searchParams));
      if(req.method==='GET' && route==='/api/report.csv') {
        const report=playbackReport(new URL(req.url,'http://localhost').searchParams,true);
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="Sterio-playback.csv"'});return res.end(reportCSV(report));
      }
      if(req.method==='POST' && route==='/api/device/admin') {setDeviceAdmin(await input(req));return json(res,200,{ok:true});}
      if(req.method==='POST' && route==='/api/device/remove') return json(res,200,removeDevice(await input(req)));
      if(req.method==='POST' && route==='/api/listener') {setListener(await input(req));return json(res,200,{ok:true});}
      if(req.method==='GET' && route==='/api/status') {
        const files=db.prepare('SELECT count(*) AS count,coalesce(sum(size),0) AS bytes FROM tracks').get();
        return json(res,200,{name:config.name,version,betaExpires:betaExpiresDay,betaExpired:betaExpired(),telemetry:telemetryState(),update:updateState(),uptime:Math.floor(process.uptime()),memory:process.memoryUsage().rss,files:files.count,bytes:files.bytes,...librarySummary(),devices:db.prepare('SELECT count(*) AS n FROM devices WHERE revoked=0 AND length(public_key)>0').get().n,scan:{...scanStatus,intervalMinutes:scanIntervalMinutes(),intervals:scanIntervals}});
      }
      if(req.method==='GET' && route==='/api/mac') return json(res,200,await macStatus());
      if(req.method==='POST' && route==='/api/mac/firewall') return json(res,200,await allowThroughFirewall());
      if(req.method==='POST' && route==='/api/mac/folder') return json(res,200,await chooseMusicFolder());
      if(req.method==='GET' && route==='/api/requests') return json(res,200,{items:pendingRequests()});
      if(req.method==='POST' && route==='/api/requests/decide') return json(res,200,decideRequest(await input(req)));
      if(req.method==='GET' && route==='/api/peers') return json(res,200,peerSummary());
      if(req.method==='POST' && route==='/api/peers/share') { limit('admin-peer-key:'+req.socket.remoteAddress,10); return json(res,200,createShareKey()); }
      if(req.method==='POST' && route==='/api/peers/connect') { limit('admin-peer-connect:'+req.socket.remoteAddress,20); await connectPeer(await input(req)); return json(res,200,peerSummary()); }
      if(req.method==='POST' && route==='/api/peers/sync') { const {id}=await input(req); void syncPeer(String(id),{force:true}).catch(()=>{}); return json(res,202,peerSummary()); }
      if(req.method==='POST' && route==='/api/peers/remove') { await removePeer(String((await input(req)).id)); return json(res,200,peerSummary()); }
      if(req.method==='POST' && route==='/api/peers/revoke') { removePeerClient((await input(req)).deviceId); return json(res,200,peerSummary()); }
      if(req.method==='GET' && route==='/api/renderers') return json(res,200,listRenderers());
      if(req.method==='POST' && route==='/api/renderers/add') {
        limit('admin-renderer:'+req.socket.remoteAddress,20);
        // The admin's LAN address with the app port; the app's playback request refines it.
        const name=host.replace(/:\d+$/,'');
        await addRenderer(await input(req),config.rendererBase || (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(name) ? `http://${name}:${config.port}` : ''));
        return json(res,200,listRenderers());
      }
      if(req.method==='POST' && route==='/api/renderers/discover') { limit('admin-renderer:'+req.socket.remoteAddress,20); return json(res,200,await discoverRenderers(host.replace(/:\d+$/,''))); }
      if(req.method==='POST' && route==='/api/renderers/remove') { await removeRenderer(String((await input(req)).id)); return json(res,200,listRenderers()); }
      if(req.method==='POST' && route==='/api/renderers/stop') { await controlRenderer({id:'admin',name:'Admin'},String((await input(req)).id),{action:'stop'},true); return json(res,200,listRenderers()); }
      if(req.method==='GET' && route==='/api/split') return json(res,200,await splitSummary());
      if(req.method==='GET' && route==='/api/sacd') return json(res,200,sacdImages());
      if(req.method==='POST' && route==='/api/split/start') return json(res,202,startSplit({force:(await input(req)).force===true}));
      if(req.method==='POST' && route==='/api/split/stop') return json(res,200,stopSplit());
      if(req.method==='POST' && route==='/api/scan') { if(!scanStatus.running) void scanLibrary().catch(error=>console.error('Admin scan:',error.message)); return json(res,202,{ok:true}); }
      if(req.method==='POST' && route==='/api/telemetry') { setTelemetry((await input(req)).enabled===true); return json(res,200,telemetryState()); }
      if(req.method==='POST' && route==='/api/scan/interval') { if(!setScanInterval(Number((await input(req)).minutes))) throw new HttpError(400,'Choose one of the offered scan intervals.'); return json(res,200,{intervalMinutes:scanIntervalMinutes()}); }
      if(req.method==='POST' && route==='/api/key') {
        limit('admin-key:'+req.socket.remoteAddress,10);
        const code=randomBytes(8).toString('hex'); const expires=Date.now()+5*60*1000;
        setSetting('pairing',JSON.stringify({hash:hash(code),expires})); return json(res,200,{code,expires});
      }
      throw new HttpError(404,'Not found');
    } catch(error) { json(res,error.status || 500,{error:error.status ? error.message : 'Unable to complete this request'}); }
  });
  server.maxConnections=32; server.maxHeadersCount=32; server.headersTimeout=10000; server.requestTimeout=120000;
  server.listen(config.adminPort,config.adminBind,()=>console.log(`Local admin listening on ${config.adminBind}:${config.adminPort}`));
  return server;
}
