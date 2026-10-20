# iOS Home recommendations

`POST /v1/discovery` requires the normal device bearer session. The optional JSON
`genreIds` array contains up to 256 existing genre identifiers. No other device ID
can be supplied: history and favourites always come from the authenticated device.

The response contains a bounded sample of chapter-aware tracks, genre labels,
aggregated listening history, recently imported albums, and the last listened item.
No file paths, keys, stream tickets or another listener's history are returned.
The client groups spelling variants/subgenres and builds stable daily playlists.
The existing reporting tables supply actual listened time; seeks and paused time
do not count. Only plays heard for at least 30 seconds or 35% of a short track
contribute positive preference signals. A very early skip adds no preference.

All selection runs in an isolated, short-lived worker thread, reading existing
SQLite metadata. No ffprobe, audio decoding, conversion or filesystem traversal is
performed. At most two workers run concurrently; a busy response lets the app retain
its saved shelf. Results are cached for ten minutes per device/genre selection,
with a maximum of 64 entries, and invalidated after a completed library scan.
Clients retain their shelf for six hours unless manually refreshed. A playlist
already opened or playing is never replaced by a refresh.

Version 0.1.16 is backward compatible with previous clients. The iOS UI is unreleased
and must be verified on the physical phone before the next requested app build.
Manual checks: two devices should get separate history; a new device should get
varied cold-start results; select genres with spelling variants; refresh after
adding music; listen while another device refreshes Home. No automated or playback
tests are run as part of this change.
