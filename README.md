# Sterio Server on a NAS

A self-hosted server for Sterio, running in Docker. The music folder is mounted read-only. The server keeps a persistent SQLite index and delivers original MP3/FLAC with metadata and original DSF/DFF. It offers search across Artists/Albums/Tracks/Genres, artwork and favorites, and authorizes clients with device keys. The default port is **7766/TCP**. Jellyfin is not required and no SSH server is started.

**DSD status:** the server indexes DSF/DFF and delivers the original file, including over HTTP Range requests. DSD → PCM conversion is available only after the app's DSD to PCM fallback option is explicitly enabled; original DSD is delivered by default. There is no artificial DSD64/128/256 limit at indexing time; recognition is limited by the FFprobe demuxer and the actual file. SACD ISO is not implemented. The updated client has a separate DoP output path on iOS/macOS and on Android 14+ with a compatible bit-perfect USB mixer. iPhone + Cayin RU9 was confirmed with DSD128 from "Bad", at a DoP transport of 352.8 kHz. The RU9 hardware volume stays controlled on the DAC; the app does not change it. Without a compatible output/rate, DSD is refused when the fallback is disabled; with the fallback enabled, the server can prepare PCM FLAC. Compressed DST, multichannel and ISO are not played by this implementation. MP3 and FLAC use the existing native playback.

**Verification:** images and clients are built separately. Automated tests were not run, at the user's request. The server is installed on the NAS, and DSD128 over DoP was verified manually on iPhone + Cayin RU9, including DSD confirmation on the DAC. Android/macOS require manual verification on hardware. The checklist is at the end.

## 1. The image

The image is published on GitHub Container Registry for Intel/AMD (`x86_64`) and 64-bit ARM (`aarch64`) NAS devices; Docker picks the right one:

```
ghcr.io/sorinb99/sterio-server:beta      # the latest beta
ghcr.io/sorinb99/sterio-server:0.2.18    # one version
```

32-bit ARM is not included. The image holds only the protected build, never the source.

## 2. Prepare the files on the NAS

Make a folder such as `/volume1/docker/sterio-server` and put `compose.yaml` in it. The examples below use Synology paths; adjust them on QNAP/Unraid/TrueNAS.

Find the UID/GID of the account that can read the collection:

```sh
id your_account_name
```

Create the data directory and give that account write access. For example, for UID 1026 and GID 100:

```sh
sudo mkdir -p /volume1/docker/sterio/data
sudo chown 1026:100 /volume1/docker/sterio/data
cd /volume1/docker/sterio-server
cp .env.example .env
```

Edit `.env`:

```dotenv
MUSIC_PATH=/volume1/music
DATA_PATH=/volume1/docker/sterio/data
PUID=1026
PGID=100
HOST_PORT=7766
BIND_IP=0.0.0.0
SERVER_NAME=Sterio NAS
BASE_PATH=
SCAN_INTERVAL_SECONDS=3600
CACHE_MAX_MB=4096
# Empty: one per CPU core minus one, up to 4.
TRANSCODE_WORKERS=
SPLIT_WORKERS=
MAX_PCM_RATE=192000
```

The music folder must exist and be readable by PUID/PGID. The data/cache directory must be writable by that user. By default the server never writes or deletes files in `/music`; the mount is `:ro`.

Optional exception: the admin action **Split albums into tracks** writes, for each CUE album, a hidden `.sterio-tracks` folder with one FLAC per track (with tags and a seek table), plus a `.sterio-split.json` marker. The folder name starts with a dot so file browsers and other players (SMB, Finder) don't list the tracks twice; the server looks for it explicitly. `Tracks` folders created by earlier versions are renamed automatically at startup, but only when everything in them was written by the server. On Windows, dot folders are hidden only when Samba has `hide dot files = yes`. The original file and CUE stay unchanged. To use this feature, set `MUSIC_ACCESS=rw` in `.env`. In the app, Settings › CUE albums › Tracks uses the split tracks and Full file plays the original image; mixes only use real tracks (native or split by the server), never the album image.

Leave space for the database and cache. The cache limit is in MiB and applies to generated files, not to the original collection.

## 3. Start the server

In `compose.yaml`, `image:` names the image (`ghcr.io/sorinb99/sterio-server:beta` follows the beta). Then:

```sh
docker compose pull
docker compose up -d --no-build
docker compose logs -f sterio
```

On older installations the command may be `docker-compose`. In Synology or Ugreen Container Manager, create a Project from `compose.yaml`, in the directory that also contains `.env`; it pulls the image itself. A running server needs no internet access.

## 4. Indexing

The scan starts automatically at startup and repeats every 15 minutes by default. Metadata is extracted with FFprobe; unchanged files are not reprocessed. Hidden directories (except the server's own `.sterio-tracks`) and symlinks are ignored. An error while reading a directory never triggers mass deletion of existing entries.

```sh
docker exec sterio node src/cli.mjs scan
docker compose logs --tail=100 sterio
```

MP3/FLAC and other compatible PCM formats are delivered as original files. Artwork is read from tags or from `cover.jpg`, `folder.jpg`, `front.jpg` and PNG equivalents in the track's folder. Albums are grouped by folder, album artist and album title; `CD1` / `Disc 1` subfolders are merged with their parent folder. Missing tags fall back to the file/folder name.

DSD is identified in the collection by its actual rate in MHz and DSD level. Very large files are never loaded fully into memory for delivery; originals are streamed with Range/Content-Length. Keeping a DSD512/1024 file on the NAS does not guarantee that the DAC, operating system or client can play that level.

For other containers the player cannot handle (for example Ogg), the server can prepare PCM FLAC, but only after the client consents. `MAX_PCM_RATE` controls PCM conversions, including the explicitly authorized DSD fallback; it does not limit original DSD. The first conversion can take a while; the complete result supports seeking and is reused from the cache. At most 2 conversions run at the same time by default, and the queue is bounded. A converted file larger than the cache limit is refused rather than delivered truncated.

## 5. Connect the app with a key

Generate a temporary code on the NAS:

```sh
docker exec sterio node src/cli.mjs pair
```

The code is random, single-use and expires after 5 minutes. Do not put it in a URL or publish it. Codes can also be generated from the local admin dashboard, or from the app by an admin device (see below).

In Sterio:

1. If you are connected to Jellyfin, go to Settings and choose Disconnect.
2. On the connection screen, select **Sterio Server**.
3. Enter the address, for example `http://nas.local:7766` on the LAN or `https://music.example.com` through a reverse proxy.
4. Enter the code and tap **Connect to Sterio**.

A P-256 signing key is generated separately for each server, in the Keychain on iOS/macOS or the Android Keystore. The private key is never exposed to JavaScript and never sent to the server; the server stores the public key. Later sign-ins use a random, single-use challenge valid for 60 seconds, signed with ECDSA/SHA-256 and bound to the server identity. This is a key-pair protocol over HTTPS, not an SSH login or OpenSSH `authorized_keys`.

API sessions expire after 30 minutes; the app renews them with the device key. Streams use separate HMAC tickets, bound to the track, device and delivery type, valid for 24 hours. Audio URLs never contain the private key or the session token. Audio tickets are still temporary secrets: do not enable query-string logging on the proxy. There is no default account or password.

If this phone is already authorized, you can leave the pairing code empty. After the device keys are deleted or the phone is restored, pairing again may be needed.

### View or revoke devices

```sh
docker exec sterio node src/cli.mjs devices
docker exec sterio node src/cli.mjs revoke FULL_DEVICE_ID
```

Revocation invalidates sessions and future audio requests. An HTTP stream that is already open cannot be withdrawn retroactively. Generate a new code to authorize the device again. All paired devices have access to the same collection; favorites and progress are kept per device. Devices can be made admin from the local dashboard (see [Server administration from the app](#server-administration-from-the-app-0122)); there are no separate user accounts.

## 6. Local network and internet

### LAN

You can use `http://nas.local:7766` or a private IP such as `http://192.168.1.10:7766`. HTTP does not encrypt traffic; use it only on a trusted local network. The signing key does not replace connection encryption. iOS may ask for Local Network access; confirm it on the phone. Android allows LAN HTTP to reach the NAS; the Sterio provider explicitly refuses public HTTP addresses.

### Recommended: reverse proxy with HTTPS

Configure Synology Reverse Proxy, Nginx Proxy Manager, Caddy, Traefik, etc.:

- external: `https://music.example.com:443`, with a valid TLS certificate;
- internal: `http://PRIVATE_NAS_IP:7766`;
- HTTP/1.1, without transforming the audio body;
- keep the `Authorization`, `Range` and `If-Range` headers;
- a read timeout of up to 900 seconds for PCM conversion preparation;
- avoid logging query strings and the Authorization header;
- do not also expose the internal HTTP port to the internet.

Nginx example: `deploy/nginx.conf.example`. The server does not use `X-Forwarded-For` to grant permissions; behind the proxy, requests share the authentication rate limit per IP. You can bind the Docker port with `BIND_IP=127.0.0.1` if the proxy runs on the NAS host. For a proxy in another container or host, use a reachable private address and suitable firewall rules.

A separate subdomain is the simplest. For `https://example.com/sterio`, set `BASE_PATH=/sterio`, keep the prefix in the proxy and enter that full address in the app.

### Alternative: TLS directly on the exposed port

Without a reverse proxy you still need HTTPS. Prepare a valid certificate for your domain and its key, readable by the container user. Add to `.env`:

```dotenv
CERTS_PATH=/volume1/docker/sterio/certs
```

The folder must contain `fullchain.pem` and `privkey.pem`. Start with:

```sh
docker compose -f compose.yaml -f deploy/compose.tls.yaml up -d --no-build
```

Port 7766 now serves HTTPS and the app address is `https://music.example.com:7766`. Forward only the TLS port and keep the certificate renewed. Restart the container after replacing the certificate. The TLS healthcheck only performs a local handshake; the app verifies the public certificate normally. Exposing the HTTP variant directly is not recommended.

## 7. Updates and backup

Keep `/data`: it holds the index, the server identity, authorized public keys, ticket secrets, favorites and the cache. The music lives in a separate folder. For a simple, consistent copy, stop the container before copying the data directory, then start it again.

To update: pull the new image and recreate the container; `/data` stays:

```sh
docker compose pull
docker compose up -d --no-build
```

Usage stats: the first time you open the dashboard, it asks whether the server may say hi once a day. With a yes it sends a random id, the version and the platform (Docker or Mac, Intel or ARM); no IP address is kept and nothing about your music leaves your network. Change it at the bottom of the dashboard, or set `TELEMETRY=false` (or `true`) in `.env`.

Beta builds stop serving music 90 days after they were built, like a TestFlight build. The dashboard shows the date ("Beta until …"); after it, the app says the beta expired. Install the latest image to keep listening: your data and settings stay in `/data`.

## 8. Manual verification

These checks were not run automatically at this stage:

1. Start the container, check the logs and that its status becomes healthy. Open `/healthz`; the response must be `{"status":"ok"}`.
2. Confirm that MP3, FLAC, DSF and DFF appear in the library with correct tags, durations and rates. Check a two-disc collection and missing tags.
3. Generate a code, connect the app and check that the same code is refused when reused or expired.
4. Check Library, Artists/Albums/Genres, universal search, artwork and favorites. Restarting the container/app must keep the device's authorization and favorites.
5. Play MP3/FLAC, pause, seek and skip to the next track. Sterio must show Original file / Direct play for these. Check playback with the phone screen locked.
6. For DSD, connect a DoP-compatible USB DAC. Check DSD recognition on the DAC and normal sound, seek/pause and disconnection. The app must refuse incompatible rates or outputs, without converting to PCM while the fallback is off. Android requires Android 14+ and a BIT_PERFECT USB mixer at the exact rate; macOS/Android need manual validation on hardware.
7. From another network with HTTPS/reverse proxy, check sign-in and seeking. Confirm HTTP is not exposed on the WAN and that an invalid certificate is refused.
8. Revoke the phone from the CLI: new requests must be refused, including a previously issued audio URL. Generate a new code and pair it again.
9. Add/modify/delete a sample file in the NAS music folder, run `scan` and check the update. Do not modify the real collection just for this test.
10. For optional PCM conversions, check the first preparation, seeking, the cache and a cache limit that is too small. Do not use these checks as proof of native DSD.

### DSD output to the DAC without conversion

DoP carries DSD bits without PCM conversion, but it is not the same USB protocol as Native DSD. The client uses DoP: DSD64 needs 176.4 kHz, DSD128 needs 352.8 kHz, DSD256 needs 705.6 kHz. The actual rate must be accepted by the system and the DAC. The app's EQ/headroom/digital volume are bypassed; the DAC's hardware volume is not changed. Do not infer digital attenuation from the volume value iOS reports for a USB DAC.

The client reads the original in HTTP Range chunks, with a short buffer and a bounded memory cache. Gapless DSD, compressed DST, multichannel and ISO are not implemented. On Android, a mixed search produces a queue of the selected format family (DSD or PCM). Internal speakers, Bluetooth and PCM-only DACs cannot be declared DSD outputs. Check the DAC's DSD indicator; the app cannot read the DAC's internal decoder. Client details are in the separate project, `sterio/docs/DSD_OUTPUT.md`.

Sources for these limits: [Android USB audio](https://source.android.com/docs/core/audio/usb), [DoP and required rates — iFi](https://downloads.ifi-audio.com/faqs/how-is-dsd512-transmitted/), [Cayin RU9 manual](https://cayin.com/ca-inhalte/uploads/2025/08/RU9_Manuel_engl.pdf). A DSD mention on a DAC data sheet does not automatically certify the same level on iOS, Android and macOS.

## New in 0.1.2: streaming, artwork and CUE

- Original streams support HTTP Range and ETag/Last-Modified validators. The app can start DSD after a short buffer and request a seek position directly, without downloading the whole file.
- Albums, artists and genres now publish image references. front.jpg, cover.jpg and folder.jpg (and PNG/WebP) are preferred; artwork embedded in the audio is also used. For artists: artist.jpg, portrait.jpg or fanart.jpg from the folder or its ancestors, with the album cover as a fallback. An unfolded cover (aspect ratio of at least 1.7) is treated as back-left / front-right; the front is displayed whole.
- The scan reads .cue files next to the audio and indexes INDEX 01 chapters. Audio files stay intact. In the app, Settings → CUE albums offers **Full file / Tracks**; selecting a chapter passes its start and end to the native player, including for compatible DSD. Clients without the 0.1.14 CUE optimization use the shared file. Updated clients can request separate cached FLAC files for FLAC chapters, without changing the audio samples (see below). Transitions are not guaranteed to be gapless.
- CUE sheets in UTF-8, UTF-16 and a Windows-1252 fallback are accepted; references must point to indexed audio files in the music folder. .wav references left over after compressing to FLAC are resolved when exactly one indexed file with the same base name exists in the same folder. An invalid CUE is ignored and logged. When several CUE sheets describe the same file, the first by path name is used, to avoid duplicate tracks.

After updating, keep the /data directory and run a scan. Phone pairing stays valid. Manually check artwork, a CUE album and a far seek on FLAC/DSD.

## DSD to PCM fallback (0.1.2)

In Settings, enable **DSD to PCM fallback** to play DSD on speakers, Bluetooth or outputs without DoP support. The option is off by default. With a compatible DAC the app prefers the original DSD; without a compatible output it explicitly asks Sterio Server for a conversion. Now Playing shows **DSD → PCM fallback**, and Sterio lists the source format and the delivered FLAC format separately.

The server decodes DSD and prepares 24-bit stereo FLAC at a rate from the same family (usually 176.4 kHz with MAX_PCM_RATE=192000). The resulting PCM is not bit-perfect DSD. The original file is not modified. The complete conversion is published atomically to the cache and can then be seeked with HTTP Range. CUE chapters use the cache of the shared source file. The first preparation can take a while, depending on the NAS and the track; later requests reuse the cache.

API: resolve requires delivery=pcm, allowConversion=true and allowDsdToPcm=true; without explicit consent DSD stays original. The authenticated POST /v1/tracks/:id/prepare endpoint responds 202 until the conversion finishes and 200 when the FLAC is ready. Conversions are bounded: the configured number of workers, the queue limit and CACHE_MAX_MB apply.

Manual check: fallback off and DAC unplugged → DSD refused; fallback on → FLAC playback with the conversion label; reconnect the DAC and start again → original DSD. Also check Next/Back, seeking and a DSD CUE if available.

The **Settings → CUE albums → Full file / Tracks** preference is saved on the device and applies to Library, Favorites and Search. Albums show **Tracks from CUE** when the list uses CUE chapters; native tracks and Full file mode have no label.

## 0.1.3: Apple FLAC compatibility

Some FLAC files use frames of only 16 samples, accepted by foobar2000 but rejected by Apple's decoder with `fmt?` / AVFoundation -11800. The server checks STREAMINFO when resolving a track and, for frames smaller than 192 samples, delivers a FLAC copy with 4096-sample frames. This lossless repack keeps the source rate, bit depth and channels, without resampling, EQ or volume normalization. The read-only original is not modified. The complete copy is published atomically to the cache and then supports HTTP Range and seeking.

The API mode is `lossless`, distinct from `transcode` (DSD → PCM or other conversions). Updated apps show "Lossless FLAC compatibility" in Sterio and only prepare the current/next track in the Apple queue. This cache is separate from the DSD conversion cache and is invalidated by mtime/size.

To install the current version from source:

```sh
docker compose build
docker compose up -d --no-build
```

The 0.1.2 packages above remain archived versions; updating to 0.1.3 or later needs the new image or a build from source. Data, pairings and the reverse proxy configuration are kept.

Manual diagnosis on "Tattoo" / Van Halen: AVAudioFile opens the 16-bit/44.1 kHz original, but reading fails with OSStatus 1718449215; the copy with 4096-sample blocks decodes correctly. The SHA-256 of the decoded PCM is identical before and after: `c7916a3b55ce246bf645a2c6b66c02529977f46a27c7ab1918eca72d7cfd469c`. No automated tests were run.

## 0.1.4: the phone controls the Mac (MVP)

Update the server and both apps. On the Mac, in Settings → Play on, click Create phone link code. On the phone, in the same section, enter the code and tap Link Mac. The code is single-use, expires after 5 minutes and only its hash is stored. Devices keep their individual private keys; `control_groups` links the phone's key to the Mac's group in SQLite. Revoking a device blocks its access and commands. There are no new accounts or passwords and no private keys are copied. Favorites stay per device in this MVP.

Select Sterio on Mac on the phone. Now Playing reflects the track and position on the Mac; play/pause, Next/Back, seeking and choosing a track or album from the phone's library are sent to the Mac, which streams audio directly from the NAS with its own audio settings and DAC. This device returns to the local player, paused. Selecting the Mac controls its queue; it does not automatically transfer the track that was playing on the phone.

MVP transport: an authenticated POST to `/v1/connect/pulse` about every 2 seconds, only while the phone app is in the foreground; the Mac stays connected while the app and the computer are active. Commands are limited to linked devices, expire after 30 seconds, have a unique ID/ack and are processed once per app session. Old commands are dropped after the Mac restarts. No sockets or new dependencies are used. The selector returns to local on relaunch; the link stays saved. At most 200 tracks in the remote queue; no volume, remote EQ, remote spectrum, multiroom sync or automatic transfer.

Auxiliary endpoints: POST `/v1/connect/link`, `/join`, `/command`; GET `/v1/tracks/:id` provides the metadata the Mac player needs. Connecting through the reverse proxy uses the existing HTTPS, with no new ports.

## 0.1.5: reliable seeking in DSD-to-PCM FLAC

DSD fallback now uses 4096-sample FLAC blocks and a one-second SEEKTABLE index. With the previous 16384-sample blocks, AVFoundation could signal end of track at an earlier seek position or fail with -11821. A new cache key avoids serving older encodings. Existing complete PCM cache files are reframed losslessly on demand; new conversions still use the existing rate/depth/channel settings. Indexing runs on the completed temporary FLAC before it is published. Original music files are never modified. The SHA-256 of decoded 32-bit PCM matched before and after reframing the Mozart sample.

Update the Docker image and recreate the container using the installation steps above. The first request prepares the new cached FLAC; playback requests after preparation use the complete file and HTTP byte ranges.

## 0.1.6: album grouping

Library scans reconcile minor album-tag differences within the same audio folder (capitalization, guest artists and misplaced radio-edit labels). The most common tag wins; ties and different physical editions remain separate. Audio files are unchanged, and album favorites are carried over. Run `docker exec sterio node src/cli.mjs scan` after updating.

## Local admin dashboard

An optional English-language dashboard on a separate LAN-only port provides server statistics, library scans, album splitting, device roles and one-use device pairing codes. It has no account: access is restricted to the configured local and VPN networks. Setup and manual checks: [Local administration](deploy/nas/ADMIN.md). It is disabled by default: set `ADMIN_ENABLED=true` and `ADMIN_BIND_IP` to the server's LAN address, then open `http://<that address>:7767`. Private networks and private-IP hosts are accepted by default, Docker Desktop's gateway included; `ADMIN_ALLOWED_NETWORKS` and `ADMIN_ALLOWED_HOSTS` narrow or extend that. The public music API does not expose admin routes.

## Fast FLAC/CUE start (0.1.14)

AVFoundation can read the entire FLAC album before playing a CUE chapter with precise positioning. For updated clients, the server prepares a separate FLAC per chapter on demand, in the cache. The audio keeps the rate, depth, channels and exactly the samples between the CUE boundaries; there is no resampling or lossy compression. Original music files are not modified. Fast FLAC compression can take slightly more cache space.

The client sends `cueDelivery: "flac-track-v1"` with resolve and prepare. Resolve starts the preparation in the background and returns `standaloneCue: true`, the `lossless` mode, the chapter ID and a signed URL. Prepare responds 202 / `retryAfterMs: 200` until the complete, indexed file is published atomically. The client plays this file from zero, without applying the CUE offset again; offline downloads keep this flag. The next track is prepared in the background. HTTP Range stays available for seeking.

The cache is invalidated when the source or the CUE boundaries change. The same limits on workers, queue, space and `CACHE_MAX_MB` apply; the cache can be recreated after eviction. The first preparation depends on the track length and the NAS. It does not apply to DSD, MP3, Full file mode or old clients; they keep their existing delivery. Installing only the server does not speed up TestFlight clients that were already distributed.

Manual verification on NAS/iPhone, 17 October 2026: Tattoo previously read 390 MB before starting (~9 s). Extracting it to the cache took 0.85 s. PCM samples and length were compared with a direct decode of the source for Tattoo, Dystopia and No One to Depend On: identical, including chapters with a non-zero offset. The first track, Good Enough, without a prepared cache, reached the player after 1.22 s, then playback started in 0.17 s. This is not a latency guarantee for every network/NAS.

## Device nicknames (0.1.15)

Updated clients save a name and platform in Settings (for example `Sorin iPhone` or `Sorin Mac`). The startup prompt offers **OK** and **Not now**, and repeats on each cold launch until a nickname is saved.

Authenticated `POST /v1/device/profile` accepts `{ "nickname": "Sorin iPhone" }` (maximum 80 characters). It can only change the authenticated device's label. An empty string clears it; an omitted field leaves the existing label unchanged. Connect pulses and playback reports also accept the same field to retry synchronization after offline use. Labels are display metadata, not authentication, and do not change pairing keys or device IDs.

The local admin dashboard uses the current nickname in Live Playback and Playback Reporting, falling back to the existing device name for older clients. No migration, new credentials, exposed admin ports or Apple ID access is needed.

## iOS discovery (0.1.16)

Server 0.1.16 adds device-scoped recommendation metadata for the app's Home. See [Discovery](docs/DISCOVERY.md) for the API, caching and manual verification.

## Split CUE albums into tracks (0.1.20–0.1.23)

Admin › **Split albums into tracks** writes each chapter of a CUE album image as its own FLAC (sample-exact, the last track runs to the end of the image, tags, `--add-seekpoint=1s`), so clients get fast starts and exact seeking. Only images with two or more chapters are split; DSD images stay whole, because a FLAC copy would be a PCM conversion. Output goes to `<album>/.sterio-tracks/` (or `.sterio-tracks/<image name>/` when one folder holds several images). The server writes an incomplete marker first and completes it last, so an interrupted album is never served; it refuses to write into a folder it did not create. Albums that are already split are recognised from the index and skipped immediately. Requires `MUSIC_ACCESS=rw`.

**Re-split all albums** (0.1.26, admin dashboard and app) writes every split album again from its image. Each track file is replaced atomically, so albums stay playable during the run; files the new marker no longer lists are removed. Track IDs stay the same, because paths do not change.

`GET /v1/tracks?albumId=…&layout=chapters` (the default) returns split tracks for split albums and CUE chapters for the rest; `layout=full` returns the original files. Discovery mixes only use real track files.

## Server administration from the app (0.1.22)

The dashboard's **Devices & nicknames** list has **Make admin / Remove admin** for each paired device. Admin devices see **Settings → Server administration** in the app, with library scan, album splitting (progress and stop) and one-use pairing codes. Authenticated endpoints: `GET /v1/admin/access` (whether the device is admin), `GET /v1/admin/status`, `POST /v1/admin/scan`, `POST /v1/admin/split/start`, `POST /v1/admin/split/stop`, `POST /v1/admin/key`. Non-admin devices receive 403 `not_admin`.

## Linked servers (0.1.28)

One Sterio server can show another server's library. Apps stay connected to their own server and browse both libraries; tracks and artwork from the other server stream through it, so apps never connect to the other server and need no access to it.

To link server B's library into server A:

1. On **B**, admin dashboard › **Linked servers** › *Share this library with another server* › **Generate server key**. The key is valid for 10 minutes and links one server, once.
2. On **A**, admin dashboard › **Linked servers**: enter B's address (`192.168.1.20:7766`, `http://…` or `https://music.example.com`) and the key, then **Connect**.

A pairs with B the way an app does: it has its own P-256 key (`/data/peer-key.pem`), signs a challenge for every session and appears on B as the device `Server · <A's name>`. Both servers need 0.1.28 or later. A link works in one direction; to show A's library on B as well, link the other way with a key generated on A.

How the libraries are combined:

- After each scan, B builds a **shared index** of its own tracks (split tracks and CUE chapters as apps see them, never tracks it receives from other linked servers, so links cannot loop). A downloads it when it changes (ETag, every 15 minutes) and stores it in its database.
- A song A already has (same album artist, album, disc and title) is hidden. Extra tracks of an album A already has join that album; other albums appear as they are on B. Artists and genres with the same name are shared. Between several linked servers, the one linked first wins.
- Linked tracks, albums and artists carry `linkedServer` (B's name) in the API, so apps can label them. Tracks of A have no such field.
- Playing a linked track: the app asks A, A resolves it on B with the same request (original, lossless repack, DSD-to-PCM conversion, CUE chapters) and returns its own stream URL. A forwards byte ranges unchanged, so seeking and downloads work as with local tracks; an expired stream ticket on B is renewed automatically.
- Album covers and artist photos are shared too. A fetches them from B once per size and keeps them with its thumbnails; the shared index carries their versions, so a cover found later on B (Library › Find artwork) reaches A and the apps at the next index update.
- Artwork chosen on A (Library › Find artwork, which also lists linked albums and artists) wins over B's. An artist both servers have shows A's own artist photo, or B's photo when only B has one.
- The artwork fill on A skips linked items B already has artwork for.

The dashboard shows, for each linked server, how many of its tracks are shown, how many A already has, and how many joined existing albums, with **Refresh index** (reads the full index again) and **Remove**. On B, *Share this library* lists the servers using it, with **Stop sharing**. Removing a link on A also revokes A's key on B when B is reachable.

## Network streamers (0.1.32)

The server can play on BluOS players (Bluesound, NAD, …) and UPnP/DLNA
renderers. The streamer fetches audio straight from this server; the server
keeps the queue and starts each next track (UPnP renderers with
`SetNextAVTransportURI` get it in advance, for gapless playback), so the app is
only a remote and can sleep or close.

- Add a streamer by IP address under **Devices → Streamers** in the admin
  dashboard (or `POST /v1/renderers {"address":"192.168.1.50"}` from the app).
  BluOS answers on port 11000; UPnP renderers are found by a unicast SSDP search
  to that address, which also works from a Docker bridge network. A UPnP
  description URL can be entered instead.
- The streamer must reach the server on the LAN. It uses the local address the
  app connects with; set `RENDERER_BASE_URL=http://192.168.1.10:7766` when the
  app reaches the server only through a public domain.
- Delivery follows the app rules: originals where the streamer plays them, CUE
  chapters as FLAC tracks, DSD as server FLAC unless the renderer lists DSD in
  `GetProtocolInfo`. Each streamer appears as its own device in live playback.
- API (signed-in devices): `GET /v1/renderers`, `POST /v1/renderers`,
  `DELETE /v1/renderers/{id}`, `POST /v1/renderers/{id}/play
  {"trackIds":[…],"index":0}`, `POST /v1/renderers/{id}/command
  {"action":"toggle|pause|resume|next|previous|seek|stop|volume"}`.
- Cover art for renderers uses a ticketed image URL; streamers never sign in.

### UPnP AV details (0.1.33)

- The renderer's `GetProtocolInfo` sink list is stored; each track is offered
  with the MIME spelling the renderer lists (`audio/x-flac`, `audio/x-dsf`, …)
  and DLNA range-seek flags for PCM. DSF/DFF go out as originals only when the
  sink lists a DSD type.
- `SetAVTransportURI` is retried after `Stop` when a renderer refuses a new URI
  while playing; `Play` is retried while the renderer is still opening it.
- When another control point starts something else on the renderer, the server
  stops following it instead of skipping that playback.

### No setup step (0.1.34)

Apps search for streamers when **Play on** opens (the server's subnet scan, plus
the phone's own search on iOS and macOS) and list them directly. Choosing one
registers it on the server automatically; BluOS and UPnP need no pairing. When
the app reaches the server only through a public domain, the server's search
uses the LAN address its streamers already use (or `RENDERER_BASE_URL`).

### Public domain (0.1.35)

When an app reaches the server only through a public domain, the server still
needs its LAN: it remembers the local address it was last reached on (the admin
dashboard or an app on the LAN) for the streamer search and as the address
streamers fetch audio from, and the client address a reverse proxy forwards as a
search hint. Without either it falls back to the public domain for streaming.
`RENDERER_BASE_URL` overrides all of this.

### Streamers on another network (0.1.36)

A listener away from the server's LAN can play on a streamer at their place:
the app finds it on the phone's network, sees that the server cannot reach it,
and controls it itself (BluOS HTTP, UPnP AV SOAP). The streamer fetches each
track from the server's public address. `POST /v1/renderers/stream
{"trackId":"…","dsd":false,"sink":["audio/x-flac"]}` returns `{ready,
retryAfterMs, item:{url, mime, title, artist, album, art, duration, segment}}`
with ticketed URLs on the address the request came to (valid for a day); when
`ready` is false the server is still converting and the app asks again. The
queue lives in the app: UPnP renderers with `SetNextAVTransportURI` get the next
track in advance, so playback continues for one track while the app is
suspended. The streamer needs internet access, HTTPS support for the public
domain, and the server's upload bandwidth.

### Artwork ready ahead (0.1.37)

After each scan the server resizes every local album cover (256 and 384 px) and
artist image (128 and 256 px) in the background, one at a time and only while
no app is waiting for artwork. Image responses may be cached for 30 days
(`private, max-age=2592000`) and no longer vary on the rotating app token, so
covers stay in the phone's cache across sign-ins; a changed cover gets a new URL
through its artwork tag.

### File type filter (0.1.38)

`GET /v1/albums`, `/v1/artists` and `/v1/genres` accept
`format=flac|dsd|mp3|alac|aac|pcm` (`pcm`: WAV and AIFF). Albums match when any
of their source files is of that type; artists and genres when any of their
tracks is. The response echoes `format`, so apps can tell an older server that
ignored it.

## Play on over WebSocket (0.1.39)

Apps keep one WebSocket to `/v1/connect/socket` while they are open. A command
from the phone reaches the linked Mac at once, and the Mac's new state (track,
play/pause, position) reaches the phone as soon as it changes, instead of on the
next 2-second pulse. The first message signs in with the app's access token;
HTTP pulses still work for older apps.

Behind a reverse proxy, WebSockets must be passed through. On Synology:
Control Panel → Login Portal → Advanced → Reverse Proxy → edit the rule →
Custom Header → Create → WebSocket. Without it, apps outside the LAN fall back to
the slower pulses.

## More clients at once (0.1.39)

- Album, artist, genre and track lists and search are built once per library
  change and shared by every request, instead of being rebuilt from the
  database for each one. Pages sort by a precomputed order.
- During a large scan, new files are published every 5 seconds instead of per
  file, so browsing stays fast while the first scan runs.
- JSON answers over 4 KB are gzip-compressed for apps that accept it.
- `TRANSCODE_WORKERS` defaults to one conversion per CPU core minus one (up to
  4); up to 64 more wait in the queue. Up to 1024 connections and 512 app
  sockets.
- `SPLIT_WORKERS` defaults to one CUE chapter per CPU core (half the cores in
  Sterio Server for Mac): chapters of up to two albums are encoded side by
  side, at a lower priority (nice 10) than streaming.
- Automatic artwork looks up six items at a time: Deezer first, then Apple
  Music, Cover Art Archive (MusicBrainz) and Wikimedia Commons, each at its own
  rate limit.
- `GET /healthz` reports memory, event-loop delay, open audio streams and app
  sockets. The log prints the same line every hour, or at once when the event
  loop p99 reaches 100 ms.

## 0.1.40

- Pulses tell the apps the server's own LAN address. When the public address
  (a reverse proxy) does not pass WebSockets, apps on the LAN open the socket
  there instead, after checking that it is the same server.
- Streamers: the log shows what each one reports when it is added (model,
  gapless, volume, accepted formats) and every command it refuses, with the
  UPnP error code. Stream URLs are never logged.

## Sterio Server for Mac (0.1.41)

For someone without a NAS: `dist/Sterio-Server.dmg` holds **Sterio Server.app**, with Node, FFmpeg/FFprobe and metaflac inside, for Apple silicon and Intel Macs on macOS 12 or later. Nothing else is installed.

- Drag the app to Applications and open it. The server runs while the app is open (Dock icon) and stops when it quits.
- Each launch, and a click on the Dock icon, opens the dashboard at `http://127.0.0.1:7767`. Under **This Mac**, **Choose music folder…** opens the Mac's folder window. The server then restarts with that folder and scans it. **Show connection code** gives the one-time code, next to the address phones use (`http://<Mac address>:7766`).
- The music folder, library, paired devices and settings stay in `~/Library/Application Support/Sterio Server`. The log is in `~/Library/Logs/Sterio Server/server.log`.
- While the app runs, the Mac does not go to sleep on its own; the display still can.
- The dashboard listens on 127.0.0.1 only. Phones on the same network reach the API on port 7766. The first time, macOS may ask to allow incoming connections and access to the local network or to the chosen folder.

Build it with:

```sh
deploy/mac/build-dmg.sh                                  # signed ad hoc
deploy/mac/build-dmg.sh "Developer ID Application: …"   # NOTARY_PROFILE=… also notarizes
```

Downloads are checked against their published SHA-256 sums and cached in `work/mac-server/downloads`. The pinned versions are Node 24.22.0, FFmpeg 9.0.2 (static builds by Martin Riedl, linked from ffmpeg.org) and metaflac built from FLAC 1.5.0.

An ad hoc signed copy received by download or AirDrop is blocked the first time. In that case, open **System Settings → Privacy & Security** and choose **Open Anyway** for Sterio Server. A copy from a USB drive opens directly. A Developer ID signature with notarization removes this step.

### 0.1.42: iPhones that cannot reach the Mac

When the macOS Application Firewall is on, the dashboard's **This Mac** card warns that iPhones cannot connect. The bundled `node` is signed ad hoc, so "Automatically allow downloaded signed software" does not cover it, and a missed or denied prompt blocks every phone. Connections from the same Mac still work, because they never cross the firewall.

**Allow iPhones to connect** asks for the Mac's administrator password once and adds `node` to the firewall's allowed apps. If **Block all incoming connections** is on, the card explains how to turn it off. **The iPhone cannot connect?** under the card lists the checks in order:
1. Open `http://<Mac>:7766/healthz` in Safari on the iPhone.
2. If Safari opens it but the app still cannot connect, turn on Local Network for Sterio in iOS.

The app now records each Sterio Server connection attempt in its exported diagnostics: the step that failed and whether the address was on the local network or the internet, but never the address itself.

## 0.1.43: the server that serves the listener converts

With linked servers, the server an app or a network streamer is connected to now makes every conversion decision for tracks of the other library: DSD → PCM FLAC, formats that need conversion, standalone FLAC for CUE chapters and FLAC repacking for Apple players. It asks the other server only for the original file (`sourceOnly`) and converts it itself, with FFmpeg reading the original over HTTP; the result is kept in its own cache. The server that shares its library only serves files and never converts for listeners of another server. A server in the middle of a chain passes the original on unchanged. Servers before 0.1.43 may still repack short-frame FLAC before sending it; that output is used as is.

The Mac server also has a Mac App Store build (`deploy/mac/build-dmg.sh --app-store`): sandboxed, with the music folder chosen in the app's own folder window and kept as a security-scoped bookmark, Node/FFmpeg/metaflac in `Contents/Helpers`, and its own peach icon (`deploy/mac/AppIcon.appiconset`, drawn by `../sterio/scripts/generate-icon.swift --variant=server --style=macos`) to tell it apart from the Sterio app.

## 0.1.44: connect with the address only, accept on the server

An app or another server no longer needs a pairing code or server key. It sends a connection request with its device key (`POST /v1/auth/request`, `POST /v1/peers/request`) and asks again every few seconds while it waits. The request appears at the top of the dashboard's Home and, for admin devices, in the app's Server administration; both sides show the same four-digit code. Accept registers the key exactly as a code would; Decline answers the requester and is remembered for five minutes. Requests are kept in memory and disappear two minutes after the requester stops asking. On a Mac, a new request opens the dashboard. Pairing codes and server keys keep working.

### 0.1.45: app connection requests reach the server

0.1.44 read the body of `POST /v1/auth/request` twice, so a phone's request arrived empty and was refused as an invalid key; server-to-server requests were not affected. The route now runs before the other `/v1/auth/` routes. Verified by hand on two local servers: a device request appears, is accepted and signs in; a server request appears, is accepted and the other server indexes the library.

### 0.1.46: conversions from a linked server over HTTPS on a Mac

The FFmpeg bundled in the Mac app does not find macOS's trusted certificates, so reading a linked server's original over HTTPS failed with `certificate verify failed` and the track did not play. The Mac app now carries a copy of the system's certificate list (`Resources/server/cacert.pem`, from `/etc/ssl/cert.pem`) and FFmpeg gets it with `-ca_file` for HTTPS sources. Docker images keep using the system store.

### 0.1.47: the Mac server survives app updates

When TestFlight replaced Sterio Server while it ran, the old server kept running its old code until its next log line failed (`EPIPE`) and crashed it. The server now stops cleanly as soon as its launcher goes away (closed output or input), so the updated app starts the new version.

### 0.1.48: DSD to PCM on a Mac

The FFmpeg in the Mac app is built without libsoxr, so every DSD → PCM conversion there failed with "Requested resampling engine is unavailable". The server now checks FFmpeg's build once and uses SoX resampling where it exists (the Docker image) and FFmpeg's own resampler at a high-quality setting (`filter_size=128:phase_shift=20:cutoff=0.97`) otherwise. Checked by hand: a 6.5-minute DSD64 track read from a linked server over HTTPS converted to 24-bit/176.4 kHz FLAC in about 8 seconds on an Apple silicon Mac.

### 0.1.49: pair a phone with a discoverable Mac

A Mac can make itself discoverable for five minutes (`POST /v1/connect/discoverable`). Phones on the same server see it in their Play on pulse (`nearby`), ask to pair (`POST /v1/connect/pair`, asked again every two seconds while waiting), and the Mac sees the request in its pulse (`pairRequests`) and accepts or declines (`POST /v1/connect/pair-decide`). Both show the same four-digit code. Accepting puts the phone in the Mac's control group, exactly as a link code does; link codes keep working. Requests are kept in memory and vanish 30 seconds after the phone stops asking. Checked by hand on a local server with a Mac and a phone session.

### 0.1.50: unpair and remove devices

Every device paired for remote control sees the others in its pulse (`linked`: id, name, platform, online) and can unpair one with `POST /v1/connect/unpair` (`{id}`). The device that joined the other's group leaves it; the other keeps its own pairings. The dashboard's Devices tab has a **Remove** button, and admin devices get the same list in the app (`GET /v1/admin/devices`, `POST /v1/admin/devices/remove`). Removing deletes the device's key, its sessions, its admin role and its remote-control pairings, and a linked server loses its access too; playback history stays for the reports. A removed device has to ask to connect again, and the app returns to its connect screen when the server says it is no longer connected.

### 0.1.51: streamers show FLAC/DSD and start linked DSD sooner

Stream URLs given to network streamers end in the file's extension (`/v1/stream/<id>.flac?ticket=…`, `.dsf`, `.dff`, …) and cover art in `.jpg`; the server accepts and ignores the extension. Streamers such as Eversolo name the format from the extension, so a FLAC no longer shows as "PCM". Cover art carries `dlna:profileID="JPEG_TN"` for renderers that require it.

A linked DSD track converted to PCM for a streamer no longer waits for the whole original to download: once the conversion has 15 seconds of audio and runs at least 1.25× faster than playback, the streamer gets the file as it grows (no length, no seeking until it is complete). Apps still wait for the finished file, which they seek with byte ranges. Linked conversions may run up to 60 minutes (15 for local files).

### 0.1.52: Sterio look and addresses without https://

The dashboard uses the Sterio colours (Petrol & Peach) and logo, with the logo as its browser icon. The Mac server has its own peach icon. A linked server's address can be typed without `https://` or a port: the server tries HTTPS first, then HTTP, each also on port 7766, and keeps the first address where a Sterio server answers.

### 0.1.53: the ribbon logo and a menu bar item on the Mac

The Sterio logo is now the ribbon S, on the dashboard (and as its browser icon) and on the Mac server's peach icon. The Mac server puts the Sterio mark in the menu bar; its menu shows whether the server runs, the library (albums, tracks, devices, scanning), the address phones use (click to copy), and Open Dashboard, Choose Music Folder, Show Music in Finder, Open at Login (macOS 13 and later), Show Server Log and Quit. A folder chosen there restarts the server with it, like one chosen on the dashboard.

### 0.2.0: new version numbering

Same code as 0.1.62. From here on the server follows the app's rules: PATCH for fixes, MINOR for a new feature or API, 1.0 with the public release.

### 0.2.3: graphite and orange

The dashboard follows the app's new dark theme: warm graphite with orange
accents. The Mac server's icon is now an orange tile with a graphite ribbon.

### 0.2.2: Home works again in the protected build

The protected build of 0.2.1 placed shared code one folder too deep, so the
Home mixes failed with "The server could not complete this request" and the
apps showed saved mixes. Shared code now sits beside the server's entry files.

### 0.2.1: faster idle, protected build

The server now ships as a bundled, obfuscated build with no readable source in
the Docker image or the Mac app. Behaviour is unchanged.

### 0.2.1: less work while idle and while you listen

- Albums ripped as one file per track with a CUE sheet beside them (EAC's multi-file layout) play their files directly. Before, each file was treated as a chapter of an image and cut from itself, a full re-encode on first play. Such tracks saved earlier as favorites or in playlists are listed under the files' own ids, so add them again.
- The scan every 15 minutes rereads only the CUE sheets and split folders that changed. When nothing changed the library keeps its revision, so apps don't reload it and the artwork thumbnails are not checked again (that took about 20 seconds after every scan).
- A long stream no longer leaves a listener behind each time the network is slower than the file (the `MaxListenersExceededWarning` in the log).
