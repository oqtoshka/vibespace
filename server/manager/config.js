import { loadOidcConfig } from '../shared/oidc.js';
import { loadManagerConfig as buildManagerConfig } from '../modules/manager-registry/index.js';

// Legacy OIDC adapter remains outside the typed configuration module.
export function loadManagerConfig(env = process.env) {
  return buildManagerConfig(env, loadOidcConfig(env));
}
