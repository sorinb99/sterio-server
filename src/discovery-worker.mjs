import { parentPort, workerData } from 'node:worker_threads';
import { buildDiscoverySeed } from './discovery.mjs';
try {
  parentPort.postMessage({value: buildDiscoverySeed(workerData.device, workerData.genreIds)});
} catch (error) {
  parentPort.postMessage({error: error.message});
}
