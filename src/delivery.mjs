import { config } from './config.mjs';
import { HttpError, streamTicket } from './auth.mjs';
import { rememberDelivery } from './reporting.mjs';
import { linkedHeader, linkedSource, rememberLinked } from './peers.mjs';
import { verbatimBits } from './verbatim.mjs';
import { conversionSource, deliveredFormat, canDeliverCueFlac, canStreamCue, needsConversion, needsLosslessRepack, prepareConversion, prepareLinkedConversion, shortFlacFrames } from './media.mjs';
// Apps that opt in play DSD → PCM and CUE chapters while the server prepares
// them (verbatim FLAC, see verbatim.mjs). CUE chapters inside a DSD image
// keep the finished file.
const streams = input => input.pcmDelivery === 'flac-verbatim-v1';
const verbatim = (track, input) => track.dsd && !track.segment && streams(input);
const reported = mode => ({ verbatim:'pcm', cueverbatim:'cue' })[mode] || mode;
// Android has no ALAC decoder: an app that says so (alacDecoder:false) gets
// ALAC repacked as FLAC, losslessly, like FLAC files Apple can't decode.
const alacRepack = (track, input) => input.alacDecoder === false && String(conversionSource(track).format.codec).toLowerCase() === 'alac';
const repackFor = async (track, input) => alacRepack(track, input) || await needsLosslessRepack(track);
const announced = mode => mode === 'verbatim' || mode === 'cueverbatim' ? { pcmDelivery:'flac-verbatim-v1' } : {};
// One delivery decision for app devices and network streamers alike.
// sourceOnly: a linked server asks for the original and converts it itself.
export async function resolveDelivery(device, track, input) {
  if (track.remote) return resolveLinked(device, track, input);
  const plain = input.sourceOnly === true;
  const conversion = !plain && (track.dsd ? input.delivery==='pcm' && input.allowDsdToPcm===true : needsConversion(track) && input.delivery !== 'original');
  if (conversion && input.allowConversion !== true) return { status:409, body:{ code:'conversion_required', error:'This audio format needs server conversion for this device.' } };
  // Explicit client opt-in keeps existing clients and full-file playback unchanged.
  const cue = !plain && !conversion && input.cueDelivery === 'flac-track-v1' && canDeliverCueFlac(track);
  const cueMode = cue && streams(input) && canStreamCue(track) ? 'cueverbatim' : 'cue';
  if (cue) await prepareConversion(track, cueMode);
  const repack = !plain && !cue && !conversion && await repackFor(track, input);
  const mode = cue ? cueMode : conversion ? (verbatim(track, input) ? 'verbatim' : 'pcm') : repack ? 'lossless' : 'original';
  const mediaId = cue ? track.id : track.sourceId||track.id;
  rememberDelivery(device.id,track.sourceId||track.id,reported(mode),conversion ? deliveredFormat(track) : track.format);
  return { status:200, body:{ mode: conversion ? 'transcode' : cue || repack ? 'lossless' : 'original', standaloneCue:cue, mediaSourceId:mediaId, segment:cue ? null : track.segment, deliveredFormat:conversion ? deliveredFormat(track) : repack && alacRepack(track, input) ? { ...track.format, codec:'flac', container:'flac' } : track.format, ...announced(mode), path:config.basePath+`/v1/stream/${mediaId}?ticket=`+streamTicket(mediaId,device.id,mode) } };
}
export async function prepareDelivery(track, input) {
  if (track.remote) return prepareLinked(track, input);
  if (input.allowConversion!==true || (track.dsd && input.allowDsdToPcm!==true)) throw new HttpError(403,'Explicit conversion permission is required');
  const cue = input.cueDelivery === 'flac-track-v1' && canDeliverCueFlac(track);
  const live = cue ? streams(input) && canStreamCue(track) : verbatim(track, input);
  const ready = await prepareConversion(track, cue ? (live ? 'cueverbatim' : 'cue') : live ? 'verbatim' : await repackFor(track, input) ? 'lossless' : 'pcm', 8000);
  return { status:ready?200:202, body:{ ready, retryAfterMs:cue || live ? 200 : 1000 } };
}

// Linked tracks: the other server only sends its original. This server makes
// the same decision as for its own files and converts here, so the server
// that shares its library never spends time converting for other listeners.
const flacFile = track => String(track.format.codec).toLowerCase() === 'flac' && String(track.format.container).toLowerCase() === 'flac';
async function linkedPlan(track, input) {
  const source = await linkedSource(track);
  // A server in the middle of a chain passes the original on as it is.
  if (input.sourceOnly === true) return { source, convert:null };
  const conversion = track.dsd ? input.delivery==='pcm' && input.allowDsdToPcm===true : needsConversion(track) && input.delivery !== 'original';
  if (conversion && input.allowConversion !== true) return { refused:true };
  if (conversion) return { source, convert:verbatim(track, input) ? 'verbatim' : 'pcm' };
  if (input.cueDelivery === 'flac-track-v1' && track.segment && !track.dsd && flacFile(track)) return { source, convert:streams(input) && verbatimBits(track.format.bitDepth || 16) ? 'cueverbatim' : 'cue' };
  // Servers before 0.1.43 may already have repacked it.
  if (source.value.mode === 'original' && flacFile(track) && shortFlacFrames(await linkedHeader(source))) return { source, convert:'lossless' };
  return { source, convert:null };
}
const sourceUrl = track => async () => (await linkedSource(track, true)).url;
async function resolveLinked(device, track, input) {
  const plan = await linkedPlan(track, input);
  if (plan.refused) return { status:409, body:{ code:'conversion_required', error:'This audio format needs server conversion for this device.' } };
  const { source, convert } = plan;
  const { media, mode } = rememberLinked(track, source, convert);
  const delivered = convert === 'pcm' || convert === 'verbatim' ? deliveredFormat(track) : convert ? track.format : source.value.deliveredFormat || track.format;
  const cue = convert === 'cue' || convert === 'cueverbatim';
  if (cue) void prepareLinkedConversion(media, track, convert, sourceUrl(track)).catch(() => {});
  rememberDelivery(device.id, track.id, reported(mode), delivered);
  const body = convert
    ? { mode:convert === 'pcm' || convert === 'verbatim' ? 'transcode' : 'lossless', standaloneCue:cue, segment:cue ? null : source.value.segment || null, deliveredFormat:delivered }
    : { ...source.value, deliveredFormat:delivered };
  return { status:200, body:{ ...body, ...announced(convert), mediaSourceId:media, path:config.basePath + `/v1/stream/${media}?ticket=` + streamTicket(media, device.id, mode) } };
}
async function prepareLinked(track, input) {
  const plan = await linkedPlan(track, input);
  if (plan.refused) throw new HttpError(403,'Explicit conversion permission is required');
  if (!plan.convert) return { status:200, body:{ ready:true, retryAfterMs:0 } };
  if (input.allowConversion !== true) throw new HttpError(403,'Explicit conversion permission is required');
  const { media } = rememberLinked(track, plan.source, plan.convert);
  const ready = await prepareLinkedConversion(media, track, plan.convert, sourceUrl(track), 8000, input.live === true && plan.convert === 'pcm');
  return { status:ready?200:202, body:{ ready, retryAfterMs:['cue','verbatim','cueverbatim'].includes(plan.convert) ? 200 : 1000 } };
}
export { sourceUrl as linkedSourceUrl };
