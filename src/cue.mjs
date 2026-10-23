import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
// Parse chapter metadata only. The referenced audio is never modified.
export async function readCue(file, relative, sources, hash) {
  const info=await stat(file);
  if(info.size>2*1024*1024) throw new Error('CUE file exceeds 2 MiB');
  const bytes=await readFile(file);
  let text;
  if(bytes[0]===0xff && bytes[1]===0xfe) text=new TextDecoder('utf-16le').decode(bytes);
  else if(bytes[0]===0xfe && bytes[1]===0xff) text=new TextDecoder('utf-16be').decode(bytes);
  else { try { text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { text=new TextDecoder('windows-1252').decode(bytes); } }
  let filename=null, current=null;
  const album={}; let tracks=[];
  const value=s => (s.startsWith('"') && s.endsWith('"')?s.slice(1,-1):s).trim().slice(0,512);
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    const line=raw.trim(); let match;
    if((match=line.match(/^FILE\s+(?:"([^"]+)"|(.+?))\s+\S+$/i))) { filename=(match[1]||match[2]).replace(/\\/g,'/'); }
    else if((match=line.match(/^TRACK\s+(\d+)\s+AUDIO$/i))) { current={file:filename,number:Number(match[1])}; tracks.push(current); }
    else if((match=line.match(/^(TITLE|PERFORMER)\s+(.+)$/i))) (current||album)[match[1].toLowerCase()]=value(match[2]);
    else if((match=line.match(/^INDEX\s+01\s+(\d+):(\d{2}):(\d{2})$/i)) && current) {
      const [minutes,seconds,frames]=match.slice(1).map(Number);
      if(seconds>=60 || frames>=75) throw new Error('Invalid CUE time');
      current.start=(minutes*60+seconds+frames/75); current.file=filename;
    }
  }
  if(tracks.length>1000) return [];
  // A CUE beside one file per track (EAC's multi-file layout) adds nothing: each
  // file already is its track and plays as it is. Only files holding several
  // tracks are images cut into chapters.
  const perFile=new Map(); for(const track of tracks) perFile.set(track.file,(perFile.get(track.file)||0)+1);
  tracks=tracks.filter(track=>perFile.get(track.file)>1);
  if(tracks.length<2) return [];
  const result=[]; const lastByFile=new Map(); const numbers=new Set();
  for(const track of tracks) {
    if(!track.file || !Number.isFinite(track.start) || !Number.isInteger(track.number) || track.number<=0 || numbers.has(track.number)) throw new Error('Incomplete or duplicate CUE track');
    numbers.add(track.number);
    const relativeAudio=path.normalize(path.join(path.dirname(relative),track.file));
    if(path.isAbsolute(track.file) || relativeAudio==='..' || relativeAudio.startsWith('..'+path.sep)) throw new Error('CUE file references an unsafe audio path');
    let source=sources.get(relativeAudio.toLowerCase());
    // CD rippers commonly retain .wav in CUE after lossless compression to FLAC.
    // Resolve only an unambiguous same-folder, same-basename indexed source.
    if(!source) {
      const wanted=path.join(path.dirname(relativeAudio),path.basename(relativeAudio,path.extname(relativeAudio))).toLowerCase();
      const candidates=[...sources.entries()].filter(([name])=>path.join(path.dirname(name),path.basename(name,path.extname(name)))===wanted);
      if(candidates.length===1) source=candidates[0][1];
    }
    if(!source) throw new Error('CUE audio file was not indexed');
    const previous=lastByFile.get(source.id);
    if(previous && track.start<=previous.segment.startSeconds) throw new Error('CUE positions must increase');
    if(track.start>=source.durationMs/1000) throw new Error('CUE track starts outside the audio');
    const item={...source,id:hash(`cue\0${relative}\0${source.id}\0${track.number}`),sourceId:source.id,cuePath:relative,
      title:track.title||`Track ${track.number}`,artist:track.performer||album.performer||source.artist,number:track.number,
      album:album.title||source.album, albumArtist:album.performer||source.albumArtist, artistId:hash(`artist\0${album.performer||source.albumArtist}`),
      segment:{startSeconds:track.start,endSeconds:source.durationMs/1000},cueTitle:album.title||source.album};
    if(previous) { previous.segment.endSeconds=track.start; previous.durationMs=Math.round((track.start-previous.segment.startSeconds)*1000); }
    item.durationMs=Math.round((item.segment.endSeconds-item.segment.startSeconds)*1000);
    lastByFile.set(source.id,item); result.push(item);
  }
  return result;
}
