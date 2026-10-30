// Web dev server for the browser smoke: the app's own config, with the /v1 proxy pointed at the e2e API port so the
// page keeps calling same-origin '/v1' (the CSP in apps/web/index.html only allows 'self' + :3000).
import { fileURLToPath } from 'node:url';
import base from '../../apps/web/vite.config';

const api = `http://localhost:${process.env.E2E_API_PORT ?? '3310'}`;
export default {
  ...base,
  root: fileURLToPath(new URL('../../apps/web', import.meta.url)),
  server: { ...base.server, proxy: { '/v1': { target: api, ws: true } } },
};
