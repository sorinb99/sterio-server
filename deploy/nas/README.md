# Local NAS installation

Configuration installed on 2026-10-16:

- NAS: `192.168.50.90` (linux/amd64).
- Project/configuration: `/volume1/docker/sterio-server`.
- Container: `sterio`, image `sterio-server:<version>` (built on the NAS from source).
- Library: `/volume2/data/media/music` → `/music`. Read-only by default; `MUSIC_ACCESS=rw` in `.env` allows album splitting.
- Persistent data: `/volume1/docker/sterio-server/data` → `/data`.
- Process: UID `1000`, GID `100`.
- Local address: `http://192.168.50.90:7766`.
- Port 7766 is published only on the LAN IP `192.168.50.90`. Public access goes through Nginx Proxy Manager at `https://sterio.filmescu.ro`, with a Let's Encrypt certificate and the app's authentication. Port 7766 is not forwarded in the router.

The effective configuration is `.env` on the NAS; the secret-free template is `.env.example` in this directory.

## Administration

In a terminal, `nas`, then:

```sh
cd /volume1/docker/sterio-server
docker compose ps
docker compose logs --tail=50 sterio
docker exec sterio node src/cli.mjs pair
```

In the app, select **Sterio Server** and enter the local address and the generated code. The code is valid for 5 minutes and a single use. The phone must have access to the NAS network.

```sh
docker exec sterio node src/cli.mjs scan
docker exec sterio node src/cli.mjs devices
```

Stop/start without deleting data:

```sh
docker compose stop
docker compose up -d --no-build
```

The initial scan runs automatically and can take a while. Playback tests remain manual. Original DSD is delivered by the server; the updated client has DoP output for compatible USB routes, confirmed with DSD128 on iPhone + Cayin RU9. Android/macOS need manual verification on hardware.

## Internet access

The setup for `https://sterio.filmescu.ro`, the Hostico DNS record and the HTTPS steps are documented in [INTERNET.md](INTERNET.md).
