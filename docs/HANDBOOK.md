# Sterio Server handbook

Start here in a new session. This file describes how the server works, where
its data lives and how it is built and deployed. **Keep it current: every
change that alters behaviour, an API route, a table, a setting or a build step
updates this file in the same commit.** `README.md` is the user-facing install
guide with a per-version changelog; `docs/ARTWORK.md`, `DISCOVERY.md`,
`RADIO.md` go deeper on single topics.

The app is the sibling project `../sterio`, with its own `docs/HANDBOOK.md`.

## What it is

A Node.js (24, no framework, no npm dependencies) music server for the Sterio
apps. It indexes a music folder (FLAC, DSD, CUE images, SACD disc images, MP3/AAC/ALAC/WAV/AIFF),
streams originals bit-perfect, converts only when asked (DSD → PCM FLAC, CUE
chapters), plays network streamers (BluOS, UPnP/DLNA, Google Cast), relays "Play on"
between a listener's devices, keeps playlists, profiles, favorites and
listening history, builds Home mixes and links to other Sterio servers.

Two ways to run it, same code:

- **Docker on a NAS** (the user's: Ugreen, Intel N100, 4 cores, 8 GB) — image
  `ghcr.io/sorinb99/sterio-server:<version>` (and `:beta`), `compose.yaml`, read-only root, `cap_drop: ALL`.
- **Sterio Server for Mac** — `deploy/mac/`: a Swift launcher app
  (`launcher/main.swift`) that bundles Node, ffmpeg/ffprobe/metaflac, starts
  `src/index.mjs` and restarts it on exit code 75; menu bar item; App Store /
  TestFlight build (bundle `com.sorinbottea.sterio.server`).

## Configuration (`src/config.mjs`)

| Variable | Default | Meaning |
|---|---|---|
| `MUSIC_DIR` | `/music` | Music folder (read-only unless `MUSIC_ACCESS=rw`; splitting needs rw) |
| `DATA_DIR` | `/data` | Database, keys, artwork, cache |
| `PORT` / `ADMIN_PORT` | 7766 / 7767 | App API / local admin dashboard |
| `ADMIN_ALLOWED_NETWORKS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Peer ranges the dashboard accepts (RFC1918 only). The default covers Docker Desktop's 172.x / 192.168.65.x gateway; who can reach the port is decided by `ADMIN_BIND_IP` |
| `ADMIN_ALLOWED_HOSTS` | `127.0.0.1:7767,localhost:7767` | Host names accepted besides `localhost` and any private IPv4 address on any port, which are always accepted (a DNS-rebinding page can only send its own domain) |
| `SERVER_NAME` | `Sterio NAS` | Name shown in the apps |
| `SCAN_INTERVAL_SECONDS` | 3600 | Library rescan interval until an administrator picks one (`scan.intervalMinutes` setting: 0 off, 15, 60, 360, 1440; dashboard Library tab or the app's Server administration, `POST /api/scan/interval` / `/v1/admin/scan/interval`). `scanWhenDue` runs every minute and starts a scan once the interval has passed since `lastFinished`, so a manual scan resets the wait. A scan with no audio change rereads only CUE sheets and split markers that changed (`cueRead`, in memory; a dashboard rescan rereads all), so an idle library keeps its revision and the thumbnail warm-up (keyed on `libraryRevision()`) does not run again |
| `MAX_PCM_RATE` | 192000 | Highest PCM rate of conversions |
| `CACHE_MAX_MB` | 4096 in code, 20480 in `compose.yaml` | Conversion cache size (NAS `.env` currently sets 4096) |
| `CACHE_MAX_DAYS` | 30 | Conversions unused this long are deleted |
| `TRANSCODE_WORKERS` | cores − 1, max 4 | Parallel conversions for playback |
| `SPLIT_WORKERS` | all cores (NAS), half the cores (Mac) | Parallel CUE chapter encodes, at nice 10 (falls back to normal priority if `nice` can't start) |
| `TELEMETRY` | unset | Daily usage ping (`telemetry.mjs`): unset, the dashboard asks once; `true`/`false` answers for good and locks the dashboard switch |
| `RENDERER_BASE_URL`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `BASE_PATH`, `ADMIN_*` | | See README |

The Mac launcher sets its own environment (data in
`~/Library/Containers/com.sorinbottea.sterio.server/Data/Library/Application Support/Sterio Server/data`,
admin on 127.0.0.1, no `CACHE_MAX_MB`, so 4 GB).

## Data and persistence

`DATA_DIR` holds: `sterio.sqlite` (+ `-wal`, `-shm`; WAL mode), `peer-key.pem`
and `ticket-secret` (server identity; losing them means re-pairing every
device), `artwork/` (downloaded artwork, previews), `cache/` (conversions,
pruned every 5 minutes and after each conversion by size and age). Containers
and app updates never touch it. No automatic backup exists; a safe copy stops
the server first or uses `sqlite3 sterio.sqlite ".backup copy.sqlite"`.

Tables (created with `CREATE TABLE IF NOT EXISTS` in the module that owns them):
`settings`, `devices`, `sessions`, `device_admins`, `tracks`, `cue_tracks`,
`split_sets`, `favorites`, `radio_likes`, `progress`, `peers`, `peer_tracks`,
`peer_media`, `peer_clients` (db.mjs); `control_groups`, `control_invites`
(connect.mjs); `profiles`, `profile_devices`, `profile_invites` (profiles.mjs);
`playlists`, `playlist_shares` (playlists.mjs); `playback_history`,
`playback_listeners` (reporting.mjs); `renderers` (renderers.mjs);
`artist_aliases`, `library_artwork`, `metadata_cache`, `artwork_candidates`
(library-state.mjs); `artwork_queries` (curation.mjs). Migrations are additive and run at start.

## Modules (`src/`)

| File | Role |
|---|---|
| `index.mjs` | HTTP server, routing, `/v1/info` (version string lives here too), timers, shutdown |
| `license.mjs` | Beta expiry: `scripts/build.mjs` writes a date 90 days after the build into the code (esbuild `define` of `process.env.STERIO_BETA_EXPIRES`); from then on every `/v1` route but `info` answers 403 `beta_expired` ("This Sterio Server beta expired on … Install the latest Sterio Server"), the Play on socket is refused, and the dashboard says so. `/healthz` and `/v1/info` (`betaExpires`) still answer. Running from `src/` never expires unless that variable is set. Both the Docker image and the Mac app carry it; the paid licence (phase 2) replaces it at release |
| `telemetry.mjs` | Opt-in usage stats. The dashboard asks once ("Can your server say hi once a day?", `#telemetry-ask`; Escape = no) and keeps a switch at the bottom (`POST /api/telemetry`, setting `telemetry` on/off; `TELEMETRY` in `.env` wins). With a yes, a protected build POSTs `{id, version, platform, arch}` to `https://sterio-stats.sorinb99.workers.dev/v1/heartbeat` 10 min after start, then daily, and once at the moment of the yes. `id` is a random 128-bit `telemetryId` setting, not the server id; platform is `docker` (`/.dockerenv`), `mac` (`STERIO_MAC_SETTINGS`) or `other`. Running from `src/` never sends |
| `auth.mjs` | Device keys (P-256), pairing codes, challenge → session, rate `limit()`, `HttpError` |
| `requests.mjs` | Connection requests (in memory) accepted on the dashboard or in the app; `requestListeners` tell `socket.mjs`, which pushes the new list to admin devices; `connectView` adds `connectionRequests` for admins so the apps can notify |
| `library.mjs` | Scan, metadata (ffprobe), CUE chapters, split folders, views (albums, artists, genres), `favorites()` per profile. `getTrack(id)` returns a file in its library form (`browsingForm`): a split track carries the image's album id, name, artist and cover, so now playing, playlists, Play on and streamers show the right artwork. Multi-disc albums (`discForm`, at browsing time, no rescan): tracks in a disc folder join one album with the lowest disc's id, titled without the disc marker (`withoutDisc`: "X CD1", "X (Disc 2)", "X (Deluxe, CD1)"), each keeping its disc (the tag, or the folder's number when the tag says 1). A folder named only by its disc (`CD 1`, `Disc 2`, `CD 02 - Covers`; the rest becomes `discTitle`) belongs to its parent album whatever the tags say; one that only ends with a disc number (`Album (Deluxe) CD 2`) joins discs with the same title. `CD1 - 2001 - Album` (a box of albums) stays apart. Albums without an ALBUMARTIST tag (compilations, soundtracks: one album per track artist otherwise) are joined the same way: tracks in one folder with one album title are one album, whose artist is the one the title names ("Eminem Presents: …"), else the one with most tracks, else Various Artists (`albumGroups`). Album covers: the first disc's folder, then the album folder, each with its front picture, then an artwork subfolder (Covers, Artwork, Art, Scans, Images, Booklet, Сканы…); artwork tag `front-v4` |
| `library-state.mjs` | Artist aliases (merges) and chosen artwork, kept in memory |
| `sacd.mjs` | SACD disc images (`.iso`) played from the image, no extraction and no cache (`docs/SACD.md`): `readSacd` reads the disc's tables, `sacdTracks` makes the stereo area's tracks (rows in `tracks`, path `image.iso#N`, `sacd` field), `sendSacd`/`sacdDsf` stream plain DSD as a DSF made on the fly with byte ranges, `writeSacdDff` writes a DST track as a temporary DSDIFF for FFmpeg's DST decoder. DST tracks always play converted to PCM (`delivery.mjs`, `dstOnly`) and are not shared with linked servers |
| `cue.mjs` | CUE parsing (metadata only). Only files holding several tracks become chapters: a CUE beside one file per track adds nothing and its files play as they are |
| `split.mjs` | Writes CUE chapters as FLAC files in a hidden `.sterio-tracks` folder with a `.sterio-split.json` marker; chapters encoded in parallel (`SPLIT_WORKERS`), two albums in flight |
| `media.mjs`, `delivery.mjs` | Streaming with Range, conversions (ffmpeg; a verbatim conversion whose write fails kills its FFmpeg), conversion cache and pruning. `resolveDelivery` picks original / lossless repack / PCM conversion / CUE; lossless repack (FLAC, frame size 4096) covers FLAC with frames Apple can't decode and ALAC for apps that send `alacDecoder:false` (Android) |
| `delivery.mjs`, `verbatim.mjs` | Live delivery while converting: FLAC with VERBATIM frames, layout fixed in advance so players can seek a file still being written. A SACD track converts in parts at once (one FFmpeg per core but one, parts of 30 s or more, `sacdPart`), each a second longer at both ends and trimmed to its own samples, so the result is identical to one FFmpeg; the PCM copy streamers get is that verbatim file packed again (`sacdVerbatim`), so a track is decoded once for apps and streamers |
| `images.mjs` | Artwork and thumbnails: widths 128, 256, 384, 600, 1000 and 2000 (the Mac app's full-size covers; an original smaller than the tier keeps its size), cached under a 1 GB ceiling |
| `curation.mjs` | Dashboard artist merges and artwork: automatic job (6 items at a time) and manual search. Providers: Deezer (first), Apple Music (iTunes Search), Cover Art Archive via MusicBrainz, Wikimedia Commons via Wikidata; each host has its own pace (MusicBrainz 1/s, iTunes 1 per 3 s, Deezer ~8/s); JSON cached 48 h in `metadata_cache`. A search name typed on the dashboard is kept per item (`artwork_queries`), prefilled there and used by the automatic job; a result counts as a match when its title is contained in that name (albums) or equals it (artists) |
| `discovery.mjs` (+ `discovery-worker.mjs`) | Home data per profile, built in a worker thread |
| `profiles.mjs` | Listener profiles: created on first use (devices paired for Play on share one), link codes, join, leave; `profileOf`, `profileDevices`, `sameProfile` |
| `playlists.mjs` | Playlists owned by a profile, shares (read-only) to other profiles |
| `connect.mjs` | Play on: presence from pulses, device list (all related devices, Macs and phones), command queue (`toggle`, `pause`, `next`, `previous`, `seek`, `play` with track ids, index, optional `position` and `paused`; each delivered command carries its `sender`), pairing (link codes, or any device made discoverable for 5 minutes: another device asks, both show a 4-digit code, the discoverable one accepts; before 0.2.17 only a Mac), `related(a,b)` = same listening circle: every device reachable through control groups and profiles (since 0.2.18, so an iPad linked to an iPhone also sees the Mac in that iPhone's profile; the linked list shows the whole circle, unlinking still only removes group members). Linking joins the two groups whole (`joinGroups`), so any number of devices share one group and each sees and controls the others; unpairing removes only the other device (a root leaving hands the group to the device that removed it). A pulse may carry `state.signal`, the playing device's Signal Path (intro, up to 10 stages, bit-perfect verdict, rate warning; text only, bounded by `signalPath()`); the devices that control it show it |
| `socket.mjs` | WebSocket for Play on: pulses, commands, pushes every device's change to related devices |
| `renderers.mjs` | Network streamers: SSDP/BluOS discovery, UPnP AVTransport, the server's own queue per streamer, polled every second while playing and every 10 s while paused. DSD is sent natively when the renderer's `GetProtocolInfo` sink lists a DSD MIME, or when the play request carries `dsd:true` (the app's Native DSD to streamers setting, kept for that session, UPnP only), else as PCM FLAC. DSF sent only because of that setting is a trial: if the streamer refuses it (load fails) or is not playing 12 s after the load, `refuseDsd` stores `dsdRefused` in the renderer's control (kept when a search finds it again) and plays the same track again as PCM from where it was; that streamer gets PCM from then on. The DIDL `<res>` carries `sampleFrequency`, `bitsPerSample` and `nrAudioChannels` with the MIME type, for streamers that show the format from them (an Eversolo T8 showed FLAC as "PCM"). Google Cast (`cast.mjs`, kind `cast`): Cast v2 over TLS on port 8009 (self-signed certificates, LAN only), Google's Default Media Receiver (`CC1AD845`) gets the same stream URL as a UPnP renderer, with title, artist, album and cover; one connection per device, heartbeat every 5 s, closed after 5 idle minutes. Name and model from `/setup/eureka_info` (port 8008, else 8443). The network search also tries port 8009 on the /24 (mDNS does not cross the Docker bridge); a speaker that also answers as UPnP or BluOS is listed only as that. Not gapless; no DSD (sent as PCM FLAC); Cast receivers generally play up to 24/96, so higher rates may not start |
| `peers.mjs` | Linked servers (one server reads another's shared index) |
| `reporting.mjs` | Listening history, device nicknames |
| `admin.mjs`, `admin/index.html`, `app-admin.mjs` | LAN dashboard and admin from the app |
| `mac.mjs` | Mac app integration (settings file, music folder) |
| `load.mjs` | Event-loop and memory reporting (`/healthz`) |

## App API (all under `/v1`, authenticated unless noted)

`info` (open), `auth/{challenge,session,pair,request,logout}`, `albums`,
`tracks`, `tracks/:id`, `stream/:id`, `images/:id`, `search`, `favorites/:id`,
`discovery`, `library/{status,rescan}`, `playback` (reports), `radio/likes`,
`device/profile` (nickname), `profile` (GET/PUT), `profile/{link,join,leave}`,
`playlists` (GET/POST), `playlists/:id` (GET/PUT/DELETE), `playlists/:id/tracks`
(POST), `playlists/:id/shares` (PUT), `connect/{pulse,command,link,join,unpair,pair,pair-decide,discoverable}`,
`renderers`, `renderers/discover`, `renderers/stream`, `renderers/:id…`,
`peers/{index,request,pair,leave}`. WebSocket for Play on on the same port.

`albums?genreId=` takes several genre ids separated by newlines (a genre
family from the app's Library) and returns albums with any of them.

## Build and deploy

- Version: `package.json`, `compose.yaml` (`image:`) and `src/index.mjs`
  (`/v1/info`) — change all three together. Same rules as the app
  (`../sterio/docs/VERSIONING.md`): PATCH for fixes, MINOR for a feature or a
  new API, 1.0 with the app's public release. 0.2.0 follows 0.1.62; 0.2.17 is the current version.
- **Protected build (`scripts/build.mjs`).** The shipped server never contains
  source. `node scripts/build.mjs` bundles `src/` with esbuild (ESM, split
  chunks, `packages: 'external'` so Node built-ins stay) and obfuscates every
  `.mjs` with javascript-obfuscator (hex names, base64 string array; control
  flow left intact so the stream and scan loops keep their speed), into
  `build/` — `build/src/*.mjs` (`index`, `cli`, `discovery-worker`,
  `healthcheck`, `chunks/`), `build/src/admin/` (minified dashboard) and a
  trimmed `build/package.json`. It also fixes the beta expiry date (build day + 90, see `license.mjs`) and prints it. The same relative layout as `src/`, so paths
  the code opens (`../package.json`, `./admin/`, `../cacert.pem`,
  `./discovery-worker.mjs`) still resolve. `build/` is git-ignored. Edit and
  run from `src/`; `build/` is only for the Docker image and the Mac app.
- Docker: a two-stage `Dockerfile`. The build stage runs `scripts/build.mjs`;
  the runtime stage copies only `build/` (plus ffmpeg, flac), so the image has
  no source, no npm, no shell scripts of ours. `HEALTHCHECK` runs
  `node src/healthcheck.mjs`. Build the deliverable image on this Mac:
  `docker buildx build --platform linux/amd64 -t sterio-server:$V --load . && docker save sterio-server:$V | gzip > work/sterio-server-$V-linux-amd64.tar.gz`.
  The deliverable `builds/Sterio-Server-Docker-$V.zip` holds `compose.yaml`,
  `README.txt` and the tar.gz.
- **Published image (since 0.2.15):** GitHub Container Registry, amd64 and arm64,
  tagged with the version and `beta`:
  `docker buildx build --builder practical_elion --platform linux/amd64,linux/arm64 -t ghcr.io/sorinb99/sterio-server:$V -t ghcr.io/sorinb99/sterio-server:beta --push .`
  The user logs Docker in to ghcr.io (a token with `write:packages`; never
  handle it). The package is public, the repository stays private; publish
  only with the user's OK. Testers install with `docker compose pull`.
- NAS deploy (`sorinb99@192.168.50.90`, `/volume1/docker/sterio-server`,
  data `/volume1/docker/sterio-server/data`, music `/volume2/data/media/music`).
  Run `work/deploy-nas.sh` (allowed for the agent since 2026-10-21; it
  sends `src`, `scripts`, `package.json`, `compose.yaml`, `Dockerfile` and
  `.dockerignore`, then `docker compose up -d --build` — the build stage on
  the NAS obfuscates the code, so the running image there has no source
  either — and prints the last log lines). Deploy after every server change. Any other change on the NAS still goes through the user.
- Mac app: `APP_BUILD=<n> deploy/mac/build-dmg.sh --app-store` runs the
  protected build, then archives, signs and exports a pkg into
  `work/mac-server/` (the app bundles `build/src`, not `src`); upload with
  `xcodebuild -exportArchive … -exportOptionsPlist work/mac-server/app-store-export-upload.plist`.
  Build numbers so far: 0.1.58 (6), 0.1.61 (7), 0.1.62 (8), 0.2.0 (9), 0.2.1 (10), …, 0.2.14 (15), 0.2.17 (16), 0.2.18 (17). Public TestFlight link: https://testflight.apple.com/join/mPHZH6uR.
- TestFlight via the App Store Connect API: key `62BSTYTAWV` (App Manager) in
  `~/.appstoreconnect/private_keys/` (never read or print it).
  `node work/testflight-expire.mjs` lists the app's 1.x and the server's 0.1.x
  builds still active; `--expire` expires them (can't be undone; ask first).

## Usage stats (`cloud/stats/`)

A Cloudflare Worker (`sterio-stats`, account sorinb99@gmail.com, free plan) with a
D1 database `sterio-stats` (`schema.sql`: `installs` one row per install with
first/last day, version, platform, arch; `days` one row per install per day).
It only accepts `POST /v1/heartbeat` with a valid body and keeps no IP; there
is no read endpoint. `cloud/stats/report.sh` prints active servers (today, 7,
30 days, ever), versions/platforms and new servers per day. Deploy with
`npx wrangler@4 deploy` in `cloud/stats` (wrangler is logged in with OAuth on
this Mac; never handle tokens). Not part of the Docker image (`.dockerignore`).

## Rules

- Nothing on the NAS changes without telling the user, except the deploy
  script above; deletions there go through the user. Commit and push after
  each change (allowed since 2026-10-21). Reading logs, `du`, `df`, mounts is fine.
  Never read the container's environment or any `.env` file.
- No automated tests or playback tests unless asked; check syntax with
  `node --check`. A quick one-off script against a temporary `DATA_DIR` in the
  scratchpad is fine to verify a code path.
- Code style: compact, comments explain why; keep each module's density.
- Commit messages: `0.2.N: what changed`, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
