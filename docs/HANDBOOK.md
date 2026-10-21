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
apps. It indexes a music folder (FLAC, DSD, CUE images, MP3/AAC/ALAC/WAV/AIFF),
streams originals bit-perfect, converts only when asked (DSD → PCM FLAC, CUE
chapters), plays network streamers (BluOS, UPnP/DLNA), relays "Play on"
between a listener's devices, keeps playlists, profiles, favorites and
listening history, builds Home mixes and links to other Sterio servers.

Two ways to run it, same code:

- **Docker on a NAS** (the user's: Ugreen, Intel N100, 4 cores, 8 GB) — image
  `sterio-server:<version>`, `compose.yaml`, read-only root, `cap_drop: ALL`.
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
| `SERVER_NAME` | `Sterio NAS` | Name shown in the apps |
| `SCAN_INTERVAL_SECONDS` | 900 | Library rescan interval |
| `MAX_PCM_RATE` | 192000 | Highest PCM rate of conversions |
| `CACHE_MAX_MB` | 4096 in code, 20480 in `compose.yaml` | Conversion cache size (NAS `.env` currently sets 4096) |
| `CACHE_MAX_DAYS` | 30 | Conversions unused this long are deleted |
| `TRANSCODE_WORKERS` | cores − 1, max 4 | Parallel conversions for playback |
| `SPLIT_WORKERS` | all cores (NAS), half the cores (Mac) | Parallel CUE chapter encodes, at nice 10 (falls back to normal priority if `nice` can't start) |
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
(library-state.mjs). Migrations are additive and run at start.

## Modules (`src/`)

| File | Role |
|---|---|
| `index.mjs` | HTTP server, routing, `/v1/info` (version string lives here too), timers, shutdown |
| `auth.mjs` | Device keys (P-256), pairing codes, challenge → session, rate `limit()`, `HttpError` |
| `requests.mjs` | Connection requests accepted on the dashboard or in the app |
| `library.mjs` | Scan, metadata (ffprobe), CUE chapters, split folders, views (albums, artists, genres), `favorites()` per profile |
| `library-state.mjs` | Artist aliases (merges) and chosen artwork, kept in memory |
| `cue.mjs` | CUE parsing (metadata only) |
| `split.mjs` | Writes CUE chapters as FLAC files in a hidden `.sterio-tracks` folder with a `.sterio-split.json` marker; chapters encoded in parallel (`SPLIT_WORKERS`), two albums in flight |
| `media.mjs` | Streaming with Range, conversions (ffmpeg), conversion cache and pruning |
| `delivery.mjs`, `verbatim.mjs` | Live delivery while converting: FLAC with VERBATIM frames, layout fixed in advance so players can seek a file still being written |
| `images.mjs` | Artwork and thumbnails |
| `curation.mjs` | Dashboard artist merges and artwork: automatic job (6 items at a time) and manual search. Providers: Deezer (first), Apple Music (iTunes Search), Cover Art Archive via MusicBrainz, Wikimedia Commons via Wikidata; each host has its own pace (MusicBrainz 1/s, iTunes 1 per 3 s, Deezer ~8/s); JSON cached 48 h in `metadata_cache` |
| `discovery.mjs` (+ `discovery-worker.mjs`) | Home data per profile, built in a worker thread |
| `profiles.mjs` | Listener profiles: created on first use (devices paired for Play on share one), link codes, join, leave; `profileOf`, `profileDevices`, `sameProfile` |
| `playlists.mjs` | Playlists owned by a profile, shares (read-only) to other profiles |
| `connect.mjs` | Play on: presence from pulses, device list (all related devices, Macs and phones), command queue, pairing (codes and discoverable Mac), `related(a,b)` = same control group or same profile |
| `socket.mjs` | WebSocket for Play on: pulses, commands, pushes every device's change to related devices |
| `renderers.mjs` | Network streamers: SSDP/BluOS discovery, UPnP AVTransport, the server's own queue per streamer. DSD is sent natively only when the renderer's `GetProtocolInfo` sink lists a DSD MIME, else as PCM FLAC |
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

## Build and deploy

- Version: `package.json`, `compose.yaml` (`image:`) and `src/index.mjs`
  (`/v1/info`) — change all three together.
- Docker image (built on this Mac for the NAS):
  `docker buildx build --platform linux/amd64 -t sterio-server:$V --load . && docker save sterio-server:$V | gzip > work/sterio-server-$V-linux-amd64.tar.gz`.
  The deliverable `builds/Sterio-Server-Docker-$V.zip` holds `compose.yaml`,
  `README.txt` and the tar.gz.
- NAS deploy (`sorinb99@192.168.50.90`, `/volume1/docker/sterio-server`,
  data `/volume1/docker/sterio-server/data`, music `/volume2/data/media/music`).
  **The user runs it**, never run it yourself:
  `cd /Users/sorinbottea/projects/sterio-server && COPYFILE_DISABLE=1 tar cf - src package.json compose.yaml | ssh sorinb99@192.168.50.90 'cd /volume1/docker/sterio-server && tar xf - && docker compose up -d --build'`.
  Afterwards `docker logs --tail 30 sterio` over ssh is fine to check the start.
- Mac app: `APP_BUILD=<n> deploy/mac/build-dmg.sh --app-store` archives, signs
  and exports a pkg into `work/mac-server/`; upload with
  `xcodebuild -exportArchive … -exportOptionsPlist work/mac-server/app-store-export-upload.plist`.
  Build numbers so far: 0.1.58 (6).

## Rules

- Nothing on the NAS changes without telling the user; the user runs deploys,
  deletions there and `git push`. Reading logs, `du`, `df`, mounts is fine.
  Never read the container's environment or any `.env` file.
- No automated tests or playback tests unless asked; check syntax with
  `node --check`. A quick one-off script against a temporary `DATA_DIR` in the
  scratchpad is fine to verify a code path.
- Code style: compact, comments explain why; keep each module's density.
- Commit only when asked: `0.1.N: what changed`, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
