# Sterio through HTTPS

Public address: `https://sterio.filmescu.ro`.

## DNS in Hostico

The authoritative nameservers for `filmescu.ro` are Hostico's. In the Hostico customer account, open **Domains → filmescu.ro → Actions → DNS Zone → Add Record** (or **cPanel → Zone Editor** if that is where this domain's zone is managed).

Add:

| Field | Value |
| --- | --- |
| Type | CNAME |
| Name | `sterio` (or `sterio.filmescu.ro.` if a full name is required) |
| Target | `filmescu.go.ro.` |
| TTL | `300` or the panel default |

This follows the same dynamic hostname as `jellyfin.filmescu.ro`. Do not add a second A or AAAA record for the same name. Leave other domain records and nameservers unchanged.

Reference: https://hostico.ro/docs/prezentarea-generala-a-zonei-dns-la-nivelul-unui-domeniu-cont-client/

## Reverse proxy

The existing `nginx-proxy-manager` container receives traffic on NAS ports **8180 → 80** and **8143 → 443**. Existing external access to Jellyfin uses this ingress. Sterio uses the same forwarding: public TCP 80 → NAS 8180 and public TCP 443 → NAS 8143. Do not forward 7766 or the NPM administration port 81 to the internet.

The persistent proxy host for `sterio.filmescu.ro` forwards to `http://192.168.50.90:7766`. It is enabled with a trusted Let’s Encrypt certificate and HTTP-to-HTTPS redirection. The configuration template is `../nginx-proxy-manager.sterio.json`; NPM assigns its own host and certificate IDs.

After DNS resolves:

1. In NPM, issue a Let's Encrypt certificate for `sterio.filmescu.ro` using HTTP validation. Public port 80 must reach the existing proxy for initial issuance and automatic renewal.
2. Select that certificate on the Sterio proxy host, enable **Force SSL**, **HTTP/2**, **HSTS** (without subdomains), then enable the proxy host.
3. Keep **Cache Assets** disabled, proxy buffering disabled and 900-second streaming timeouts. The `/` custom location uses HTTP/1.1 and preserves byte ranges needed for seek.
4. Access/error logging for this host is disabled to avoid retaining signed stream URLs. NPM retains its administrative audit trail. Other hosts retain their own logging settings.

NPM manages certificate renewal. Certificates and its database stay in `/volume1/docker/nginx-proxy-manager`; Sterio persistent data and device pairing stay in `/volume1/docker/sterio-server/data`.

## App connection and manual check

Use `https://sterio.filmescu.ro` as the Sterio Server address in the app. If the app requests pairing for the new URL, generate a fresh one-use code on the NAS:

```sh
docker exec sterio node src/cli.mjs pair
```

Pairing codes expire after five minutes. Existing paired device keys are not removed by the proxy configuration.

For the final manual check, disable Wi-Fi on the phone and connect over mobile data. Check album art, PCM playback, DSD fallback and seek. This verifies actual access outside the home network; a LAN check alone cannot confirm the router's external forwarding.

## Deployment status

Activated on 2026-10-16: NPM proxy host **5**, certificate **7** (Let’s Encrypt, expires 2027-01-14), Force SSL, HTTP/2 and HSTS enabled. Hostico CNAME resolves through `filmescu.go.ro`. Verified: valid HTTPS, `/healthz` returns 200, HTTP redirects to HTTPS, library and stream endpoints return 401 without authorization, and Nginx configuration validation succeeds. Playback over mobile data remains a manual phone check. A consistent NPM database backup was saved inside the NPM data volume at `sterio-backups/` before the change. The NAS music server remains bound to the LAN address and port 7766.
