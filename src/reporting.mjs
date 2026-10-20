import { randomUUID } from 'node:crypto';
import { db } from './db.mjs';
import { getTrack } from './library.mjs';
import { HttpError } from './auth.mjs';

const GRACE_MS=45000;
const transfers=new Map(), deliveries=new Map();
const text=(value,max=200)=>String(value || '').replace(/[\x00-\x1f]/g,' ').slice(0,max);
const safeError=value=>text(value).replace(/https?:\/\/\S+/gi,'[URL]');
const cleanState=value=>['playing','paused','buffering','interrupted','error','ended','idle'].includes(value)?value:'playing';
db.exec(`CREATE TABLE IF NOT EXISTS playback_listeners (device_id TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playback_history (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, listener TEXT NOT NULL DEFAULT '',
 track_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
 started INTEGER NOT NULL, last_seen INTEGER NOT NULL, ended INTEGER, listened REAL NOT NULL DEFAULT 0,
 position REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0, status TEXT NOT NULL,
 platform TEXT NOT NULL DEFAULT '', route TEXT NOT NULL DEFAULT '', delivery TEXT NOT NULL DEFAULT 'unknown',
 source_format TEXT NOT NULL, output_format TEXT, error TEXT NOT NULL DEFAULT '', end_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS playback_history_date ON playback_history(started DESC);
CREATE INDEX IF NOT EXISTS playback_history_device ON playback_history(device_id,started DESC);
CREATE UNIQUE INDEX IF NOT EXISTS playback_history_active ON playback_history(device_id) WHERE ended IS NULL;`);
// A restart ends the old observation window; it does not invent listening time.
db.prepare("UPDATE playback_history SET ended=last_seen,status='stopped',end_reason='Server restarted' WHERE ended IS NULL").run();
const active=id=>db.prepare('SELECT * FROM playback_history WHERE device_id=? AND ended IS NULL').get(id);
function finish(row,reason,now=row.last_seen) {
  db.prepare("UPDATE playback_history SET ended=?,status='stopped',end_reason=? WHERE id=?").run(now,reason,row.id);
}
export function expirePlayback() {
  for(const row of db.prepare('SELECT * FROM playback_history WHERE ended IS NULL AND last_seen<?').all(Date.now()-GRACE_MS)) finish(row,'Device stopped reporting');
  for(const [key,value] of deliveries) if(value.at<Date.now()-86400000) deliveries.delete(key);
}
function identity(deviceId) {
  return db.prepare('SELECT devices.name,coalesce(playback_listeners.label,\'\') AS label FROM devices LEFT JOIN playback_listeners ON playback_listeners.device_id=devices.id WHERE devices.id=?').get(deviceId) || {name:'Unknown device',label:''};
}
function transport(deviceId,track) {
  return deliveries.get(deviceId+':'+(track.sourceId || track.id));
}
export function rememberDelivery(deviceId,trackId,mode,format) {
  if(deliveries.size>=4096) deliveries.delete(deliveries.keys().next().value);
  deliveries.set(deviceId+':'+trackId,{mode,format,at:Date.now()});
}
function update(row,input,now) {
  const position=Number.isFinite(input.position)?Math.max(0,Math.min(input.position,604800)):row.position;
  const status=cleanState(input.status || (input.paused?'paused':'playing'));
  const elapsed=Math.max(0,(now-row.last_seen)/1000), delta=position-row.position;
  // Never turn seeks, buffering, network gaps or paused time into listened time.
  const heard=row.status==='playing' && elapsed<=GRACE_MS/1000 && delta>0 && delta<=elapsed+2 ? Math.min(elapsed,delta) : 0;
  const route=input.route===undefined?row.route:text(input.route,120);
  const platform=input.platform===undefined?row.platform:text(input.platform,32);
  const error=input.error===undefined?row.error:safeError(input.error);
  db.prepare('UPDATE playback_history SET last_seen=?,position=?,listened=listened+?,status=?,route=?,platform=?,error=? WHERE id=?').run(now,position,heard,status,route,platform,error,row.id);
}
export function recordPlayback(device,input) {
  updateDeviceNickname(device,input);
  if(typeof input.trackId!=='string')throw new HttpError(400,'Invalid playback report');
  const track=getTrack(input.trackId);
  if(!track || !Number.isFinite(input.position) || input.position<0 || input.position>604800 || !['start','progress','stop'].includes(input.kind)) throw new HttpError(400,'Invalid playback report');
  const now=Date.now(); let row=active(device.id);
  if(row && now-row.last_seen>GRACE_MS) {finish(row,'Device stopped reporting');row=null;}
  if(input.kind==='stop') {
    if(row?.track_id===track.id) {update(row,{...input,status:'paused'},now);finish(row,'Stopped or track changed',now);}
    return;
  }
  if(row && (row.track_id!==track.id || input.kind==='start' && now-row.started>5000)) {finish(row,'Next playback',now);row=null;}
  if(!row) {
    const who=identity(device.id), delivery=transport(device.id,track);
    const id=randomUUID();
    db.prepare(`INSERT INTO playback_history (id,device_id,device_name,listener,track_id,title,artist,album,started,last_seen,position,duration,status,platform,route,delivery,source_format,output_format,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,device.id,who.name,who.label,track.id,text(track.title,512),text(track.artist,512),text(track.album,512),now,now,input.position,(track.durationMs||0)/1000,cleanState(input.status || (input.paused?'paused':'playing')),text(input.platform || who.name.match(/Sterio (ios|android|macos)/i)?.[1],32),text(input.route,120),delivery?.mode||'unknown',JSON.stringify(track.format),delivery?.format?JSON.stringify(delivery.format):null,safeError(input.error));
    row=active(device.id);
  } else update(row,input,now);
  const delivery=transport(device.id,track);
  if(delivery) db.prepare('UPDATE playback_history SET delivery=?,output_format=? WHERE id=?').run(delivery.mode,delivery.format?JSON.stringify(delivery.format):null,row.id);
}
export function observePulse(device,state,platform) {
  const row=active(device.id); if(!row)return;
  const trackId=state.trackIds?.[state.index || 0];
  if(trackId!==row.track_id) return;
  // Pulse enriches reports, but cannot create phantom plays from loaded queues.
  update(row,{position:state.position,status:state.status,route:state.route,platform,error:state.error},Date.now());
  if(['error','ended','idle'].includes(state.status)) finish(active(device.id),state.status,Date.now());
}
export function trackTransfer(req,res,deviceId,trackId,mode) {
  if(req.method!=='GET')return;
  const id=randomUUID(), track=getTrack(trackId);
  transfers.set(id,{id,deviceId,trackId,title:track?.title || 'Unknown track',started:Date.now(),mode});
  const done=()=>transfers.delete(id);res.once('finish',done);res.once('close',done);
}
function view(row,labels) {
  const who=labels ? {label:labels.get(row.device_id)||''} : identity(row.device_id);
  return {id:row.id,deviceId:row.device_id,deviceName:row.device_name,listener:who.label,title:row.title,artist:row.artist,album:row.album,trackId:row.track_id,started:row.started,lastSeen:row.last_seen,ended:row.ended,listened:row.listened,position:row.position,duration:row.duration,status:row.status,platform:row.platform,route:row.route,delivery:row.delivery,sourceFormat:JSON.parse(row.source_format),outputFormat:row.output_format?JSON.parse(row.output_format):null,error:row.error,endReason:row.end_reason,stale:!row.ended && Date.now()-row.last_seen>20000};
}
export function livePlayback() {
  expirePlayback();
  return {sessions:db.prepare('SELECT * FROM playback_history WHERE ended IS NULL ORDER BY started DESC').all().map(row=>view(row)),transfers:[...transfers.values()].map(item=>({...item,deviceName:identity(item.deviceId).label || identity(item.deviceId).name})),devices:db.prepare("SELECT devices.id,devices.name,devices.revoked,coalesce(playback_listeners.label,'') AS listener,device_admins.device_id IS NOT NULL AS admin FROM devices LEFT JOIN playback_listeners ON playback_listeners.device_id=devices.id LEFT JOIN device_admins ON device_admins.device_id=devices.id WHERE devices.public_key<>'' ORDER BY devices.name").all()};
}
export function latestPlayback() {
  const labels=new Map(db.prepare('SELECT device_id,label FROM playback_listeners').all().map(row=>[row.device_id,row.label]));
  const rows=db.prepare(`SELECT h.* FROM devices d JOIN playback_history h ON h.rowid=(
    SELECT rowid FROM playback_history WHERE device_id=d.id ORDER BY started DESC,rowid DESC LIMIT 1
  ) ORDER BY h.started DESC,h.rowid DESC`).all();
  return {items:rows.map(row=>({deviceId:row.device_id,deviceName:row.device_name,listener:labels.has(row.device_id)?labels.get(row.device_id):row.listener,title:row.title,artist:row.artist,started:row.started}))};
}
export function updateDeviceNickname(device, input) {
  if (input.nickname === undefined) return;
  if (typeof input.nickname !== 'string' || input.nickname.length > 80 || /[\x00-\x1f\x7f]/.test(input.nickname)) throw new HttpError(400,'Invalid nickname');
  const label=input.nickname.trim().replace(/\s+/g,' ');
  if (identity(device.id).label !== label) setListener({deviceId:device.id,label});
}
export function setListener(input) {
  if(typeof input.deviceId!=='string' || !db.prepare('SELECT id FROM devices WHERE id=?').get(input.deviceId) || typeof input.label!=='string' || input.label.length>120) throw new HttpError(400,'Invalid listener');
  db.prepare('INSERT INTO playback_listeners VALUES (?,?) ON CONFLICT(device_id) DO UPDATE SET label=excluded.label').run(input.deviceId,text(input.label,120).trim());
}
function criteria(params) {
  const days=Math.min(366,Math.max(1,Number(params.get('days'))||30));
  const from=params.get('from')?Date.parse(params.get('from')+'T00:00:00Z'):Date.now()-days*86400000;
  const to=params.get('to')?Date.parse(params.get('to')+'T00:00:00Z')+86400000:Date.now()+1;
  if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)throw new HttpError(400,'Invalid date range');
  let where='started>=? AND started<?';const values=[from,to];
  if(params.get('device')){where+=' AND device_id=?';values.push(params.get('device'));}
  const q=text(params.get('q'),100).trim();
  if(q){where+=" AND (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' OR device_name LIKE ? ESCAPE '\\' OR device_id IN (SELECT device_id FROM playback_listeners WHERE label LIKE ? ESCAPE '\\'))";const match='%'+q.replace(/[\\%_]/g,'\\$&')+'%';values.push(match,match,match,match,match);}
  return {where,values,from,to};
}
export function playbackReport(params,exporting=false) {
  expirePlayback();
  const {where,values,from,to}=criteria(params);
  const offset=Math.max(0,Math.min(1000000,Math.floor(Number(params.get('offset'))||0)));
  const labels=new Map(db.prepare('SELECT device_id,label FROM playback_listeners').all().map(row=>[row.device_id,row.label]));
  const total=db.prepare(`SELECT count(*) AS plays,coalesce(sum(listened),0) AS listened,count(DISTINCT device_id) AS devices,count(DISTINCT track_id) AS tracks FROM playback_history WHERE ${where}`).get(...values);
  const items=db.prepare(`SELECT * FROM playback_history WHERE ${where} ORDER BY started DESC LIMIT ? OFFSET ?`).all(...values,exporting?10000:50,exporting?0:offset).map(row=>view(row,labels));
  const topTracks=db.prepare(`SELECT title,artist,count(*) AS plays,sum(listened) AS listened FROM playback_history WHERE ${where} GROUP BY track_id ORDER BY listened DESC LIMIT 5`).all(...values);
  const topDevices=db.prepare(`SELECT device_id AS deviceId,device_name AS name,count(*) AS plays,sum(listened) AS listened FROM playback_history WHERE ${where} GROUP BY device_id ORDER BY listened DESC LIMIT 5`).all(...values).map(row=>({...row,listener:labels.get(row.deviceId)||''}));
  const days=db.prepare(`SELECT strftime('%Y-%m-%d',started/1000,'unixepoch') AS day,count(*) AS plays,sum(listened) AS listened FROM playback_history WHERE ${where} GROUP BY day ORDER BY day`).all(...values);
  return {items,total,topTracks,topDevices,days,offset,from,to,limit:exporting?10000:50};
}
const csvCell=value=>'"'+String(value??'').replace(/^(?:\s*[=+@-]|[\t\r\n])/,"'$&").replace(/"/g,'""')+'"';
const describe=f=>f?[f.codec,f.bitDepth?f.bitDepth+'-bit':'',f.sampleRate?f.sampleRate+' Hz':'',f.channels?f.channels+' ch':''].filter(Boolean).join(' · '):'';
export function reportCSV(report) {
  const rows=[['Started (UTC)','Ended (UTC)','Device','Device ID','Listener','Track','Artist','Album','Listened seconds','Position seconds','Duration seconds','State','Platform','Output device','Delivery','Source format','Delivered format','Error','End reason']];
  for(const row of report.items)rows.push([new Date(row.started).toISOString(),row.ended?new Date(row.ended).toISOString():'',row.deviceName,row.deviceId,row.listener,row.title,row.artist,row.album,row.listened.toFixed(1),row.position.toFixed(1),row.duration,row.status,row.platform,row.route,row.delivery,describe(row.sourceFormat),describe(row.outputFormat),row.error,row.endReason]);
  return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
const timer=setInterval(expirePlayback,15000);timer.unref();
