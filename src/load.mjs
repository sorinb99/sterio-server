import { monitorEventLoopDelay } from 'node:perf_hooks';

// How busy the server is, for the log: memory, and how long requests waited
// for the JavaScript thread. A slow p99 means some work belongs off it.
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
const counters = { streams: 0, sockets: 0 };
export const load = {
  stream(change) { counters.streams += change; },
  socket(change) { counters.sockets += change; },
};
export function loadStats() {
  const memory = process.memoryUsage();
  return {
    rssMb: Math.round(memory.rss / 1048576),
    heapMb: Math.round(memory.heapUsed / 1048576),
    eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6),
    eventLoopMaxMs: Math.round(delay.max / 1e6),
    streams: counters.streams,
    sockets: counters.sockets,
  };
}
let reportedAt = 0;
setInterval(() => {
  const stats = loadStats();
  // Every hour, or at once when the thread was held up.
  if (stats.eventLoopP99Ms >= 100 || Date.now() - reportedAt >= 3600000) {
    reportedAt = Date.now();
    console.log(`Server load: ${stats.rssMb} MB memory (${stats.heapMb} MB heap), event loop p99 ${stats.eventLoopP99Ms} ms (max ${stats.eventLoopMaxMs} ms), ${stats.streams} streams, ${stats.sockets} app sockets`);
  }
  delay.reset();
}, 60000).unref();
