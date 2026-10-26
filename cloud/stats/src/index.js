// Sterio Server usage stats: a server whose owner said yes on the dashboard
// sends one heartbeat a day. Only a random install id (not the server id), the
// version, platform and CPU architecture are kept; no IP address or anything
// from the library (0.2.15 test builds also sent a library size range). There
// is no read endpoint: the numbers are read with `wrangler d1 execute`
// (report.sh) or in the Cloudflare dashboard.
const PLATFORMS = new Set(['docker', 'mac', 'other']);
const ARCHES = new Set(['x64', 'arm64', 'arm', 'other']);
const SIZES = new Set(['0', '1-1k', '1k-10k', '10k-50k', '50k+']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/heartbeat') return new Response('Not found', { status: 404 });
    if (Number(request.headers.get('content-length') || 0) > 1024) return new Response('Too large', { status: 413 });
    let input;
    try { input = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const { id, version, platform, arch, tracks } = input || {};
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(version)
      || !PLATFORMS.has(platform) || !ARCHES.has(arch) || (tracks !== undefined && !SIZES.has(tracks))) return new Response('Invalid heartbeat', { status: 400 });
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO installs (id, first_seen, last_seen, version, platform, arch, tracks) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(id) DO UPDATE SET last_seen = ?2, version = ?3, platform = ?4, arch = ?5, tracks = ?6`).bind(id, day, version, platform, arch, tracks ?? '-'),
      env.DB.prepare('INSERT OR IGNORE INTO days (day, id) VALUES (?1, ?2)').bind(day, id),
    ]);
    return new Response(null, { status: 204 });
  },
};
