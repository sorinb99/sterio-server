// Anonymous usage stats (cloud/stats), only with the owner's yes: the dashboard
// asks once (or TELEMETRY=true/false in .env answers it). Once a day a
// protected build says it is up, with a random install id (not the server id),
// its version and platform; never names, music, paths or addresses. Running
// from src/ never sends.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { config } from './config.mjs';
import { getSetting, setSetting } from './db.mjs';
import { betaExpires } from './license.mjs';
const endpoint = 'https://sterio-stats.sorinb99.workers.dev/v1/heartbeat';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const choice = () => config.telemetry ?? (getSetting('telemetry') === undefined ? undefined : getSetting('telemetry') === 'on');
export const telemetryEnabled = () => choice() === true;
// asked: answered on the dashboard or in .env; locked: .env decides.
export const telemetryState = () => ({ enabled: telemetryEnabled(), asked: choice() !== undefined, locked: config.telemetry !== undefined });
// A yes says hi at once, so the owner's server shows up the same day.
export function setTelemetry(on) { setSetting('telemetry', on ? 'on' : 'off'); if (on && betaExpires) void heartbeat(); }
function installId() {
  let id = getSetting('telemetryId');
  if (!id) { id = randomBytes(16).toString('hex'); setSetting('telemetryId', id); }
  return id;
}
async function heartbeat() {
  if (!telemetryEnabled()) return;
  const platform = process.env.STERIO_MAC_SETTINGS ? 'mac' : existsSync('/.dockerenv') ? 'docker' : 'other';
  const arch = ['x64', 'arm64', 'arm'].includes(process.arch) ? process.arch : 'other';
  try {
    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ id: installId(), version, platform, arch }) });
  } catch {}
}
// Ten minutes after start (a crash loop sends nothing), then once a day.
export function startTelemetry() {
  if (!betaExpires) return;
  setTimeout(() => void heartbeat(), 600000).unref();
  setInterval(() => void heartbeat(), 86400000).unref();
}
