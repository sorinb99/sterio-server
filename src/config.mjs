import os from 'node:os';
import path from 'node:path';
const integer = (name, fallback, min, max) => {
  const raw = process.env[name];
  const value = Number(raw === undefined || raw === '' ? fallback : raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
export const config = {
  adminEnabled: process.env.ADMIN_ENABLED === 'true',
  adminPort: integer('ADMIN_PORT', 7767, 1, 65535),
  adminBind: process.env.ADMIN_BIND_ADDRESS || '0.0.0.0',
  adminNetworks: (process.env.ADMIN_ALLOWED_NETWORKS || '').split(',').filter(Boolean),
  adminHosts: (process.env.ADMIN_ALLOWED_HOSTS || '127.0.0.1:7767,localhost:7767').split(','),
  port: integer('PORT', 7766, 1, 65535),
  host: process.env.BIND_ADDRESS || '0.0.0.0',
  name: process.env.SERVER_NAME || 'Sterio NAS',
  music: path.resolve(process.env.MUSIC_DIR || '/music'),
  data: path.resolve(process.env.DATA_DIR || '/data'),
  basePath: '/' + (process.env.BASE_PATH || '').split('/').filter(Boolean).join('/'),
  scanSeconds: integer('SCAN_INTERVAL_SECONDS', 900, 30, 86400),
  maxPcmRate: integer('MAX_PCM_RATE', 192000, 44100, 384000),
  cacheBytes: integer('CACHE_MAX_MB', 4096, 128, 1048576) * 1024 * 1024,
  // Conversions in parallel: one core stays free for the API and streaming.
  workers: integer('TRANSCODE_WORKERS', Math.max(1, Math.min(4, os.availableParallelism() - 1)), 1, 16),
  tlsCert: process.env.TLS_CERT_FILE,
  tlsKey: process.env.TLS_KEY_FILE,
  // Address network streamers use to fetch audio, e.g. http://192.168.1.10:7766
  rendererBase: process.env.RENDERER_BASE_URL || '',
};
if (config.basePath === '/') config.basePath = '';
