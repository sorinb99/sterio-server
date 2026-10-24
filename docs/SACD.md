# SACD disc images

Sterio Server plays SACD disc images (`.iso`) straight from the music folder.
Each image is an album with its tracks; audio is read from the image while it
plays. Nothing is extracted, nothing is cached, and the image is only read, so
the music folder may stay read-only. DVD-Audio, Blu-ray and data discs are not
SACDs: they are listed as skipped and left alone. Stereo area only.

## Reading the disc (`src/sacd.mjs`)

Scarletbook layout, as documented by sacd-ripper (`scarletbook.h`); 2048-byte
sectors, big-endian values.

- **Master TOC**, sector 510, `SACDMTOC`: album set size and number (16, 18),
  disc catalogue number (88), date (120), text channel character set (138),
  the two area TOCs (stereo at 64 with its size at 84, multichannel at 72/86).
- **Master Text**, sector 511, `SACDText`: offsets of the album title (16),
  album artist (18), disc title (32), disc artist (34). Disc title and artist
  win over the album's.
- **Area TOC** (`TWOCHTOC`): channels (32), loudspeaker config (33, high five
  bits), frame format (21, low nibble: 0 DST, 2/3 plain DSD), sample rate (20,
  4 = DSD64), total time (64), track count (69), audio area start and end
  (72, 76). Then `SACDTRL1` (start sector and length of each track),
  `SACDTRL2` (start time and duration, minutes/seconds/frames at 75 per
  second) and `SACDTTxt` (title and performer per track).
- Text uses the disc's character set through `TextDecoder` (Latin-1,
  Shift-JIS, KS C 5601, GB 2312, Big5).

**Audio sectors.** A header byte (packet count, frame starts, DST flag), two
bytes per packet (frame start, type, length), three bytes per frame start
(timecode; four with DST: plus the frame's packet count), then the packets. A
frame is 1/75 s. Plain DSD stereo frames are 9408 bytes, the two channels'
bytes interleaved, most significant bit first. Frames are kept by their
timecode within the track's time, so tracks never overlap; a frame the image
lacks becomes DSD silence, so a track always has its exact length.

## Library (`library.mjs`)

The scan collects `.iso` files. An image whose size and modification time are
unchanged keeps its tracks; a new or changed one is read again (a few sectors).
Its tracks are rows in `tracks` with the image's size and mtime, path
`<image>#<track>` and a `sacd` field (image, area bounds, track sectors and
frames, DST). One album per image (`hash(album, folder, artist, title)`),
artist from the track performer or the disc artist, year from the disc's
date, genre Uncategorized. Covers come from the image's folder (`front.jpg`,
`cover.jpg`, an artwork subfolder); an image has no picture of its own.
`sacdSkipped` keeps the images of the last scan that are not SACDs.

## Playing

- **Plain DSD** is `dsd`/`dsf`: the original is a DSF file made on the fly
  (`sendSacd`). Its size follows from the frame count (92-byte header, then
  4096-byte blocks per channel, bits least significant first), so byte ranges
  work as with a file: a range finds its frame and the sector it starts in by
  binary search on the sectors' timecodes. DSD → PCM for apps and streamers
  feeds the same DSF to FFmpeg on its input.
- **DST** is `dst`/`iso` and always plays converted to PCM (`dstOnly` in
  `delivery.mjs`, also for devices that play DSD). For each conversion the
  track's DST frames are written to a temporary DSDIFF in the cache folder
  (about 1 s; FFmpeg's DSDIFF reader needs a file, not a pipe), FFmpeg's DST
  decoder converts it, and the file is removed when the conversion ends
  (leftovers older than a day go in `pruneCache`). The PCM result is a normal
  conversion, like any DSD file's. DST tracks are not shared with linked
  servers, which ask for originals.
- **Conversions run in parts**: a track is cut into parts of 30 s or more,
  one per core but one (at most 8), each its own track of image frames
  (`sacdPart`, from the sector its first frame starts in) with its own DSF
  stream or DSDIFF file and FFmpeg. A part decodes a second (75 frames) before
  and after its edges and keeps exactly its own samples, so the joined file is
  identical to one FFmpeg's. The verbatim file can stream while parts finish
  in any order: readers get bytes up to the first frame not written yet. The
  compressed PCM copy (streamers) packs the finished verbatim file again
  instead of decoding the DSD a second time.
- Every SACD track's format carries `image: 'iso'` (also in album
  `formats`); the apps show "DSD ISO" and "SACD ISO". Tracks indexed by
  0.2.10 are read again once to get it.
- The apps route DSD with `needsDsdOutput`: DST tracks from an image need no
  DSD output and no DSD to PCM setting.

## Interface

- Dashboard, Library tab: card **SACD discs** (`GET /api/sacd`): one row per
  image (album, artist, "Stereo · DSD, native" or "DST, plays as PCM", tracks,
  length, file, year) and the skipped images with the reason.
- App, Server administration: section **SACD discs** from
  `/v1/admin/status` → `sacd` (`{ images, skipped }`).

## Later

A metadata and sector map cache per disc (faster first seek and first scan of
large libraries), a decoded-DST cache, multichannel areas.
