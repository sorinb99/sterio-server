# Artwork delivery (0.1.17)

Authenticated `GET`/`HEAD /v1/images/:id?width=...` selects a maximum size of 128,
256, 384, 600 or 1000 px. Requests without a size default to 384 px; old clients
remain compatible. Covers are compressed JPEGs, keeping aspect ratio, existing
front-cover selection and artist portrait handling. No upscaling is applied.

Derivatives are created from the existing artwork image, not by processing the
audio delivery path. Atomic writes, per-image job coalescing, at most two artwork
jobs and one codec thread per job bound background resource consumption. Covers
already rendered or fetched by curation are reused. A bounded in-memory lookup
avoids repeating folder/audio metadata work for each image request within five
minutes; artwork version and completed scan changes invalidate that lookup.

Derivatives persist in `/data/cache/thumbnails-v1`. Every ten minutes a separate
cleanup targets 256 MiB, keeping in-flight and newly written (under one hour)
assets. This is a soft limit during large bursts. Audio cache files are untouched.

Responses use `Cache-Control: private, max-age=3600`, `Vary: Authorization`, ETag,
Last-Modified, and conditional 304 responses. Authentication still precedes every
network image request. Reverse proxies must not override private cache controls.
Manually selected artwork changes its existing versioned URL; changes to a local
cover with no updated tag can take up to one hour to expire from device HTTP cache.

The media `sendFile` and HTTP Range/stream/DSD/CUE paths are unchanged. Inspection
must compare representative artwork sizes/headers on NAS without playback tests;
phone cold/warm launch and scrolling remain manual checks in the updated client.
