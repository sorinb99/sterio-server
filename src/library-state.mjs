import path from 'node:path';
import { db } from './db.mjs';
import { config } from './config.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS artist_aliases (source_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, source_name TEXT NOT NULL, target_name TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS library_artwork (entity_id TEXT PRIMARY KEY, filename TEXT NOT NULL, version TEXT NOT NULL, provider TEXT NOT NULL, source_url TEXT NOT NULL, credit TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS artwork_candidates (token TEXT PRIMARY KEY, entity_id TEXT NOT NULL, value TEXT NOT NULL, created INTEGER NOT NULL);`);
let aliases=new Map(),artworks=new Map();
export let stateRevision=0;
export function reloadLibraryState(){stateRevision++;aliases=new Map(db.prepare('SELECT * FROM artist_aliases').all().map(row=>[row.source_id,row]));artworks=new Map(db.prepare('SELECT * FROM library_artwork').all().map(row=>[row.entity_id,row]));}
reloadLibraryState();
export const artistNameKey=value=>String(value).normalize('NFKC').toLowerCase().replace(/&/g,' and ').replace(/\b(?:feat\.?|ft\.?)\s+/g,'featuring ').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
export function canonicalArtist(id,name){const seen=new Set();while(aliases.has(id)&&!seen.has(id)){seen.add(id);const alias=aliases.get(id);id=alias.target_id;name=alias.target_name;}return {id,name};}
export function applyArtistAlias(item){const artist=canonicalArtist(item.artistId,item.albumArtist);if(artist.id===item.artistId)return item;return {...item,artistId:artist.id,albumArtist:artist.name,artist:artistNameKey(item.artist)===artistNameKey(item.albumArtist)?artist.name:item.artist};}
export const artworkTag=(id,fallback)=>artworks.get(id)?.version || fallback;
export function storedArtwork(id){const value=artworks.get(id);return value?{...value,path:path.join(config.data,'artwork',value.filename)}:null;}
