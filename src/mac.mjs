import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { config } from './config.mjs';
import { HttpError } from './auth.mjs';

// Sterio Server for Mac: the launcher app starts this server with
// STERIO_MAC_SETTINGS and restarts it on exit code 75. The music folder is
// chosen in the local dashboard: the launcher shows the folder window, saves
// the choice and starts the server again with access to that folder.
const settingsFile = process.env.STERIO_MAC_SETTINGS || '';
export const macMode = !!settingsFile;
// The Mac App Store copy runs in the App Sandbox: macOS allows it through the
// firewall itself, and the firewall cannot be read or changed from inside.
const sandboxed = !!process.env.STERIO_MAC_SANDBOX;
// The launcher went away (quit, crashed, or replaced by an update): stop
// cleanly instead of crashing on the next log line, so the new copy can start.
if (macMode) {
  let gone = false;
  const leave = () => { if (!gone) { gone = true; process.kill(process.pid, 'SIGTERM'); } };
  process.stdout.on('error', leave);
  process.stdin.on('end', leave);
  process.stdin.resume();
}
function settings() {
  try { return JSON.parse(readFileSync(settingsFile, 'utf8')) || {}; } catch { return {}; }
}
// Addresses a phone on the same network uses for this Mac.
function addresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const item of list || [])
      if (item.family === 'IPv4' && !item.internal && /^en\d/.test(name) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))
        found.push(`http://${item.address}:${config.port}`);
  return found;
}
// The macOS Application Firewall lets this Mac reach the server but stops
// iPhones: the bundled node is signed ad hoc, so "allow signed software" does
// not cover it, and a missed or denied prompt blocks every phone.
const firewallTool = '/usr/libexec/ApplicationFirewall/socketfilterfw';
const run = (args) => new Promise(resolve => execFile(firewallTool, args, { timeout: 5000 }, (error, stdout) => resolve(error ? '' : String(stdout))));
let firewallCache, firewallAt = 0;
async function firewall() {
  if (!macMode || sandboxed) return null;
  if (firewallCache && Date.now() - firewallAt < 10000) return firewallCache;
  const [state, blockAll, apps] = await Promise.all([run(['--getglobalstate']), run(['--getblockall']), run(['--listapps'])]);
  // "Firewall is enabled. (State = 1)"; 2 is "Block all incoming connections".
  const level = Number(state.match(/State = (\d)/)?.[1] ?? (/is enabled/i.test(state) ? 1 : 0));
  const enabled = level > 0;
  const lines = apps.split('\n');
  const at = lines.findIndex(line => line.includes(process.execPath));
  const allowed = at >= 0 && /Allow incoming/i.test(lines[at + 1] || '');
  firewallCache = { enabled, blockAll: enabled && (level === 2 || /set to enabled/i.test(blockAll)), allowed };
  firewallAt = Date.now();
  return firewallCache;
}
export async function macStatus() {
  const saved = settings().musicDir;
  return { enabled: macMode, musicDir: saved && saved === config.music ? saved : null, addresses: addresses(), name: config.name, firewall: await firewall() };
}
// One administrator prompt adds the bundled node to the firewall's allowed apps.
export async function allowThroughFirewall() {
  if (!macMode || sandboxed) throw new HttpError(404, 'Not found');
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const command = `${firewallTool} --add ${quote(process.execPath)} && ${firewallTool} --unblockapp ${quote(process.execPath)}`;
  const script = `do shell script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with prompt "Sterio Server needs to let your iPhone connect to this Mac." with administrator privileges`;
  await new Promise((resolve, reject) => execFile('osascript', ['-e', 'activate', '-e', script], { timeout: 5 * 60 * 1000 }, (error, stdout, stderr) => {
    if (error) reject(new HttpError(/-128|cancel/i.test(stderr || '') ? 409 : 500, /-128|cancel/i.test(stderr || '') ? 'Cancelled.' : 'The firewall could not be changed.'));
    else resolve();
  }));
  firewallCache = null;
  return macStatus();
}
// The launcher answers on standard input: "chosen<TAB>/path", "cancelled" or "failed".
let answers = null, pending = '';
function launcherAnswer() {
  if (!answers) {
    answers = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        answers.shift()?.(line);
      }
    });
    // Without the launcher listening the dashboard must not wait forever.
    process.stdin.on('end', () => { while (answers.length) answers.shift()('failed'); });
  }
  return new Promise(resolve => answers.push(resolve));
}
let choosing = false;
export async function chooseMusicFolder() {
  if (!macMode) throw new HttpError(404, 'Not found');
  if (choosing) throw new HttpError(409, 'The folder window is already open on this Mac.');
  choosing = true;
  try {
    const answer = launcherAnswer();
    process.stdout.write('\n@@sterio choose-folder\n');
    const line = await answer;
    if (line === 'cancelled') return { cancelled: true };
    if (!line.startsWith('chosen\t')) throw new HttpError(500, 'The folder window could not be opened.');
    // The launcher saved the folder; it starts the server again, which scans it at once.
    setTimeout(() => process.emit('sterio-restart'), 300);
    return { musicDir: line.slice(7), restarting: true };
  } finally { choosing = false; }
}
