// Docker HEALTHCHECK: the server answers /healthz on its own port.
import { config } from './config.mjs';
const scheme = config.tlsCert ? 'https' : 'http';
fetch(`${scheme}://127.0.0.1:${config.port}${config.basePath}/healthz`).then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));
