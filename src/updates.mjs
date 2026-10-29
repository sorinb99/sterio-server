// Tells the dashboard when a newer Sterio Server image is out, so the owner
// can pull it; the server never updates itself (that would need the Docker
// socket). Docker only, and only while the dashboard is open: at most one
// read of the public ghcr tag list every six hours, sending nothing about
// this server. UPDATE_CHECK=false in .env turns it off.
import { existsSync, readFileSync } from 'node:fs';
import { config } from './config.mjs';
const image = 'sorinb99/sterio-server';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const enabled = config.updateCheck && existsSync('/.dockerenv');
let latest = null, checkedAt = 0, checking = false;
const parts = v => v.split('.').map(Number);
const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
async function check() {
  checking = true;
  try {
    const signal = AbortSignal.timeout(10000);
    const { token } = await (await fetch(`https://ghcr.io/token?scope=repository:${image}:pull`, { signal })).json();
    const { tags } = await (await fetch(`https://ghcr.io/v2/${image}/tags/list`, { headers: { Authorization: `Bearer ${token}` }, signal })).json();
    latest = tags.filter(tag => /^\d+\.\d+\.\d+$/.test(tag)).reduce((best, tag) => newer(tag, best) ? tag : best, version);
  } catch {} finally { checkedAt = Date.now(); checking = false; }
}
// The first dashboard load starts a check; the answer shows on a later refresh.
export function updateState() {
  if (!enabled) return null;
  if (!checking && Date.now() - checkedAt > 21600000) void check();
  return latest && newer(latest, version) ? { latest } : null;
}
