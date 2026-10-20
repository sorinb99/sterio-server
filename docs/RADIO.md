# Radio preferences

Radio audio streams directly from Radio Paradise to the client. No audio is recorded on the server.

Authenticated `GET /v1/radio/likes` lists this device’s likes. `PUT /v1/radio/likes` saves a Radio Paradise song ID (`rp:<song_id>`), title, artist and album; `DELETE` removes it. Requests use the normal device session. Events from different broadcasts share the same song ID. Up to 500 likes are retained per device, stored in SQLite independently of the local music catalog.

Home uses liked artists as an additional preference with a 90-day decay. This influences library mixes and external album discovery; a like is not counted as a listening session or a downloaded track. Unliking removes that preference. For sources other than Sterio Server, likes stay on the client.

The client exposes the eight public music channels: Main, Mellow, RockIt!, The Globe, Beyond, Sanctuary, Serenity and KFAT. Sanctuary is a continuous AAC stream and has no individual song to like. The other seven use FLAC song blocks. Radio2050 is an episode catalog, linked separately to Radio Paradise’s website. My Favorites requires a Radio Paradise account and Mellow X is their sandbox; neither is a public music channel.

Official channel metadata: https://vsh-sdata.radioparadise.com/api/channels and https://api.radioparadise.com/api/what_is_playing .
