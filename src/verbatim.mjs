// FLAC with uncompressed (VERBATIM) frames: still lossless FLAC, but every
// frame has a size known in advance. The whole layout, STREAMINFO and SEEKTABLE
// included, is fixed before any audio exists, so a player can read and seek a
// file that is still being converted.
const BLOCK = 4096;
// Sample sizes this writer handles, with their frame header codes.
const sizeCodes = { 16:4, 24:6 };
const rateCodes = { 88200:1, 176400:2, 192000:3, 44100:9, 48000:10, 96000:11 };
const crc8Table = new Uint8Array(256), crc16Table = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  crc8Table[i] = c;
  let d = i << 8;
  for (let b = 0; b < 8; b++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  crc16Table[i] = d;
}
const utf8Length = n => n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
function utf8(n) {
  const length = utf8Length(n);
  if (length === 1) return [n];
  const out = new Array(length);
  for (let i = length - 1; i > 0; i--) { out[i] = 0x80 | (n & 0x3f); n = Math.floor(n / 64); }
  out[0] = ((0xff00 >> length) & 0xff) | n;
  return out;
}
// Header bytes: sync, block size from the end of the header, rate, channels,
// sample size, frame number, block size - 1, CRC-8.
const headerLength = index => 4 + utf8Length(index) + 2 + 1;
const frameLength = (index, samples, channels, bytes) => headerLength(index) + channels * (1 + samples * bytes) + 2;

// bits: 16 or 24 (see sizeCodes).
export function verbatimLayout({ sampleRate, channels, samples, bits = 24 }) {
  if (!sizeCodes[bits]) throw new Error(`Unsupported verbatim sample size ${bits}`);
  const bytes = bits / 8;
  const frames = Math.ceil(samples / BLOCK);
  const frameSamples = index => index === frames - 1 ? samples - index * BLOCK : BLOCK;
  // One seek point per second, at the frame holding that second.
  const points = [];
  for (let second = 0; second * sampleRate < samples; second++) {
    const index = Math.floor(second * sampleRate / BLOCK);
    if (points.at(-1) !== index) points.push(index);
  }
  const metadata = 4 + 4 + 34 + 4 + points.length * 18;
  const offsets = new Float64Array(frames + 1);
  offsets[0] = metadata;
  let minFrame = Infinity, maxFrame = 0;
  for (let index = 0; index < frames; index++) {
    const length = frameLength(index, frameSamples(index), channels, bytes);
    offsets[index + 1] = offsets[index] + length;
    minFrame = Math.min(minFrame, length); maxFrame = Math.max(maxFrame, length);
  }
  const header = Buffer.alloc(metadata);
  header.write('fLaC', 0, 'ascii');
  header.writeUInt32BE(34, 4); // STREAMINFO, not last
  header.writeUInt16BE(Math.min(BLOCK, samples), 8); header.writeUInt16BE(BLOCK, 10);
  header.writeUIntBE(frames ? minFrame : 0, 12, 3); header.writeUIntBE(maxFrame, 15, 3);
  const packed = (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(samples);
  header.writeBigUInt64BE(packed, 18);
  // MD5 left as zeros: unknown until the audio exists, which FLAC allows.
  header.writeUInt32BE((0x83000000 | points.length * 18) >>> 0, 42); // SEEKTABLE, last
  points.forEach((index, i) => {
    const at = 46 + i * 18;
    header.writeBigUInt64BE(BigInt(index * BLOCK), at);
    header.writeBigUInt64BE(BigInt(offsets[index] - metadata), at + 8);
    header.writeUInt16BE(frameSamples(index), at + 16);
  });
  return { header, size: offsets[frames], frames, offsets, frameSamples, sampleRate, channels, samples, bits, bytes };
}

// interleaved: little-endian samples of layout.bits, all channels, for one frame.
export function verbatimFrame(layout, index, interleaved) {
  const { channels, sampleRate, bytes } = layout, samples = layout.frameSamples(index);
  const frame = Buffer.alloc(frameLength(index, samples, channels, bytes));
  frame[0] = 0xff; frame[1] = 0xf8;
  frame[2] = (7 << 4) | (rateCodes[sampleRate] || 0);
  frame[3] = ((channels - 1) << 4) | (sizeCodes[layout.bits] << 1);
  let at = 4;
  for (const byte of utf8(index)) frame[at++] = byte;
  frame.writeUInt16BE(samples - 1, at); at += 2;
  let crc = 0;
  for (let i = 0; i < at; i++) crc = crc8Table[crc ^ frame[i]];
  frame[at++] = crc;
  for (let channel = 0; channel < channels; channel++) {
    frame[at++] = 0x02; // VERBATIM subframe, no wasted bits
    const step = channels * bytes;
    if (bytes === 3) for (let i = 0, source = channel * 3; i < samples; i++, source += step) {
      frame[at++] = interleaved[source + 2]; frame[at++] = interleaved[source + 1]; frame[at++] = interleaved[source];
    }
    else for (let i = 0, source = channel * 2; i < samples; i++, source += step) {
      frame[at++] = interleaved[source + 1]; frame[at++] = interleaved[source];
    }
  }
  let crc16 = 0;
  for (let i = 0; i < at; i++) crc16 = ((crc16 << 8) & 0xffff) ^ crc16Table[(crc16 >> 8) ^ frame[i]];
  frame.writeUInt16BE(crc16, at);
  return frame;
}
export const verbatimBlock = BLOCK;
export const verbatimBits = bits => bits <= 16 ? 16 : bits <= 24 ? 24 : null;
