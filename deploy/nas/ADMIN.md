# Local server administration

Open **http://192.168.50.90:7767** from the NAS local network. The interface is in English and provides album, artist, track, file size, paired-device, uptime and memory statistics, live scan progress, **Scan library**, **Split albums into tracks**, **Make admin / Remove admin** per device, and **Generate key**.

Generate key creates the same one-use, five-minute pairing code as `docker exec sterio node src/cli.mjs pair`. Enter the code in the Sterio client. The private P-256 key is created on that client and never shown or downloaded from the dashboard. Generating another code invalidates the previous unused code.

## Access

There is no account or password. The dashboard opens directly, but only for clients on the configured local and VPN networks (`ADMIN_ALLOWED_NETWORKS`) using an allowed Host. Changes are accepted only from the dashboard's own origin as JSON, which blocks cross-site requests from other web pages. Older credentials saved with the removed `admin-account` command are ignored.

## Local access configuration

```dotenv
ADMIN_ENABLED=true
ADMIN_BIND_IP=192.168.50.90
ADMIN_HOST_PORT=7767
ADMIN_ALLOWED_NETWORKS=192.168.50.0/24
ADMIN_ALLOWED_HOSTS=192.168.50.90:7767,127.0.0.1:7767,localhost:7767
```

The Docker port is bound to the NAS LAN IP. The dedicated listener checks the actual peer address against the allowed LAN CIDR; it does not trust proxy headers. Only configured Host values are accepted. All changes require the exact same origin and a JSON request body.

### Docker Desktop on a Mac

Docker Desktop runs the container in a VM, so the browser's connection never arrives from 127.0.0.1. With the dashboard port published on 127.0.0.1, it arrives from the compose network gateway (a 172.16–31.x address, such as 172.19.0.1). The app port published on 0.0.0.0 sees 192.168.65.1 instead. Allow both:

```dotenv
ADMIN_ENABLED=true
ADMIN_BIND_IP=127.0.0.1
ADMIN_HOST_PORT=7767
ADMIN_ALLOWED_NETWORKS=192.168.65.0/24,172.16.0.0/12
ADMIN_ALLOWED_HOSTS=127.0.0.1:7767,localhost:7767
```

Only the Mac itself can reach the port bound to 127.0.0.1. Open http://localhost:7767. A 403 "Local network access only" means the peer address is outside these ranges. `docker exec sterio cat /proc/net/tcp` shows it in hex.

**Do not forward port 7767 in the router or add it to the public reverse proxy.** The existing public app API stays on port 7766; it does not serve the admin interface. This LAN dashboard uses HTTP, so use it on your trusted local network. Public API TLS configuration is unchanged.

## Manual checks

1. Open the local address and confirm the dashboard loads without a sign-in step.
2. Check counters against the library. Click Scan library and watch progress until completion.
3. Generate key and pair a spare client within five minutes. Confirm the same code cannot be reused.
4. Public `https://sterio.filmescu.ro/api/status` must not expose the dashboard.
5. Check a client outside the allowed LAN cannot reach the admin listener. Do not add a port-forward to test this.

No automated or playback tests were run for this change.

## Playback dashboard (0.1.9)

**Live playback** uses compact square cards: device/listener, playback state, track, artist, audio format and numeric playback time. There is no progress bar. Audio output details remain available in the format tooltip. The page refreshes every five seconds; existing clients send progress approximately every ten seconds. Active HTTP transfers remain in a collapsed section and do not count as listening.

**Playback reporting** shows only the most recent track per device, including the artist, optional listener name and time it started. It covers all recorded history, without date filters, charts, totals, export controls or pagination. Devices without a recorded play are omitted. Existing history remains in SQLite; this interface change does not delete it.

Sessions waiting more than twenty seconds for an update are marked stale and close after forty-five seconds. A suspended/offline client can disappear while its buffer still plays. History starts with server 0.1.8; prior last-position records cannot reconstruct old listening. A server restart closes existing live observations.

**Devices & listener names** lets the administrator assign a label to an already paired device. Apple ID is not supplied by the current app or TestFlight. Reporting covers Sterio Server tracks, not Jellyfin or direct Radio Paradise streams.

Manual checks: start a library track, check the square live card and numeric time, then switch tracks. Playback reporting should show one entry for that device with its newest track. Repeat on a second device, reload, and confirm one latest track per device. No automated or playback tests were run for the layout change.

## Artists & artwork (0.1.10)

### Merge duplicate artists

Open **Artists & artwork → Merge duplicate artists**. Suggestions compare names conservatively: case, spacing, `&` / `and`, and `feat.` / `featuring`. Featured performers are retained, so a solo artist is not automatically combined with their band or collaboration. **Review merge** fills the source/target selectors; the preview tells you which albums will appear under the chosen artist. **Merge artists** applies it immediately. Manual source/target selection is also supported.

Merges are persistent aliases in SQLite. They do not modify tags, move folders, combine album editions, change album/track IDs or rewrite audio. CUE browsing and ordinary tracks use the same aliases. Source artist favorites are copied to the target. **Applied merges → Undo** restores separate browsing; it does not remove copied favorites. Refresh the library in the client after a change.

### Find artwork

Open **Find album & artist artwork**:

- **Fill missing album covers** checks local/embedded artwork first, then searches MusicBrainz releases and downloads approved front covers from Cover Art Archive.
- **Fill missing artist photos** checks for local `artist`, `portrait` or `fanart` images. Album covers used as artist placeholders do not prevent a real artist photo from being found. It resolves an exact MusicBrainz artist to Wikidata P18 / Wikimedia Commons, storing the supplied author/license credit and source page.
- Bulk jobs run one at a time, preserve existing images, report counters/current item and support **Stop** after the current lookup. No match is preferable to the wrong artist/album. Ambiguous/unknown items remain unchanged.
- For manual selection, type an album, artist or year in **Library item**. Results update immediately, ignoring case and accents; up to 12 matches are shown (keep typing to narrow them). Click a result, or use Arrow Up/Down and Enter; Escape closes the results. **Show all albums** opens the complete alphabetic album list in a scrollable panel; **Hide album list** closes it. Then optionally adjust the online search name, click **Find artwork**, inspect the preview/credits and click **Use this image**. This explicitly overrides the displayed artwork for that item. **Use original artwork** removes that online override.

Artist names with multiple exact matches remain manual choices. Recognizable trailing edition/catalog/CD labels are removed for album lookup, without changing stored titles.

Only artist/album search names are sent to the providers. Server credentials, music paths, device keys and audio are never uploaded. Provider metadata is cached for 48 hours; outbound requests are serialized and spaced at least 1.1 seconds apart, with time/size limits and an HTTPS provider-domain allowlist (including redirect checks). Image previews are decoded locally to static JPEGs; source SVG/HTML are rejected. No API key is needed.

Images live under `/data/artwork`, with credits, cache-busting versions and aliases in `/data/sterio.sqlite`. Back up the whole data directory. Scan library does not erase these customizations. Refresh the library in the app to receive updated image tags. Matching is based on metadata, not audio fingerprinting; digital/physical edition cover differences may require manual selection. Provider availability, coverage and rate limits can leave some items without artwork.

Sources: [MusicBrainz rate limits](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), [Cover Art Archive API](https://musicbrainz.org/doc/Cover_Art_Archive/API), [Wikimedia image metadata](https://www.mediawiki.org/wiki/API:Imageinfo).

Manual checks: review and merge an equivalent spelling, refresh the client, confirm both sets of albums appear under one artist, rescan and verify the merge persists, then check Undo. Search a known album and artist, preview/apply an image, refresh the client and confirm it loads through the existing image endpoint. Run a fill-missing job and check that existing covers are preserved and progress/Stop work. Playback testing remains manual.

Manual artwork searches return up to 16 images: approved front covers across more MusicBrainz releases for albums, and the linked artist photo plus Wikimedia Commons search results for artists. Counts depend on provider availability. Commons search results need manual identity review; they are never applied by bulk fill. Bulk fill keeps its conservative exact-match behavior.

## Home VPN access (NAS WireGuard)

The installed NAS also accepts home WireGuard clients at the same address, **http://192.168.50.90:7767/**. The VPN must route the home LAN through the tunnel. The network allowlist and Host/origin checks remain required; no admin reverse proxy or router port forwarding is added.

The verified deployment uses:

- VPN clients: `10.8.0.0/24`.
- Docker external network: `wg-easy_default` (`172.19.0.0/16`).
- Fixed WireGuard container address: `172.19.0.2`.
- Fixed Sterio address: `172.19.0.250`.
- `ADMIN_ALLOWED_NETWORKS=192.168.50.0/24,10.8.0.0/24,172.19.0.2/32` in the NAS `.env`.

Docker's published-port hairpin path hides VPN traffic behind a shared bridge gateway. Do not allow that general gateway or the entire Docker subnet. Instead, `compose.vpn.yaml` is installed as `/volume1/docker/sterio-server/compose.override.yaml`, joining the WireGuard network with a fixed address. `wg-easy.sterio.override.yaml` is installed as `/volume1/docker/wg-easy/compose.override.yaml`; it retains the existing WireGuard firewall rules and adds a single DNAT rule for traffic entering **wg0**, from **10.8.0.0/24**, to **192.168.50.90:7767**. That traffic reaches Sterio directly and is masqueraded to the explicitly allowed WireGuard address. The rule does not affect the public app API on 7766 or other home services.

These are NAS-specific overrides: verify addresses/network names before installing elsewhere, and merge with an existing override rather than replacing it. Both projects use normal `docker compose up -d` so the network assignments and WireGuard startup/shutdown rules survive recreation. WireGuard must be running before starting Sterio on a fresh host, since it owns the external network.

Verification performed: LAN admin HTTP 200, direct WireGuard gateway to admin HTTP 200 with the expected Host header, public reverse-proxy container to admin HTTP 403, public Sterio API HTTP 200. The wg0 ingress DNAT rule is installed; the final remote-phone check is manual: turn off Wi-Fi, connect the home VPN, open the LAN admin URL. This gateway check does not claim an actual off-site phone tunnel test.

Before this change the NAS `.env` and compose file were backed up as `.env.before-admin-vpn` and `compose.yaml.before-admin-vpn`. Rollback: stop Sterio, remove its `compose.override.yaml`, restore the previous allowed-network setting; remove only the Sterio-specific WireGuard override/rule (preserving any later changes), recreate WireGuard, then start Sterio on its original Compose network.
