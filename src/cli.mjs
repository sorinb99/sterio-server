import { randomBytes } from 'node:crypto';
import { db, hash, setSetting } from './db.mjs';
const [command, argument] = process.argv.slice(2);
if (command === 'pair') {
  const code = randomBytes(8).toString('hex');
  setSetting('pairing',JSON.stringify({hash:hash(code),expires:Date.now()+5*60*1000}));
  console.log(`Pairing code (one use, valid for 5 minutes): ${code}`);
} else if (command === 'devices') {
  for (const device of db.prepare('SELECT id,name,created,revoked FROM devices ORDER BY created').all()) console.log(`${device.id}  ${device.name}  ${device.revoked ? 'REVOKED' : 'authorized'}  ${new Date(device.created).toISOString()}`);
} else if (command === 'revoke' && /^[a-f0-9]{64}$/.test(argument || '')) {
  db.prepare('UPDATE devices SET revoked=1 WHERE id=?').run(argument);
  db.prepare('DELETE FROM sessions WHERE device_id=?').run(argument);
  console.log('Device revoked; its sessions and future stream requests will be rejected.');
} else if (command === 'scan') { setSetting('scan.request',Date.now()); console.log('Library rescan requested.'); }
else { console.log('Usage: node src/cli.mjs pair | devices | revoke <device-id> | scan'); process.exitCode=1; }
db.close();
