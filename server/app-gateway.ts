import fs from 'node:fs';

import { AppGateway } from './modules/app-deployments/index.js';

// Separate executable: no manager, auth provider or worker modules are loaded.
const { VS_APPS_REGISTRY, VS_APPS_SIGNING_KEY_FILE, VS_APPS_NONCE_DB } = process.env;
if (!VS_APPS_REGISTRY || !VS_APPS_SIGNING_KEY_FILE || !VS_APPS_NONCE_DB) {
  throw new Error('App registry, signing key file and nonce database are required');
}
const gateway = new AppGateway({ registry: VS_APPS_REGISTRY,
  signingKey: fs.readFileSync(VS_APPS_SIGNING_KEY_FILE, 'utf8').trim(), nonceDatabase: VS_APPS_NONCE_DB });
gateway.server.listen(Number(process.env.SERVER_PORT || '8080'), process.env.HOST || '0.0.0.0');
process.once('SIGTERM', () => gateway.close());
process.once('SIGINT', () => gateway.close());
