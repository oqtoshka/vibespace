// Host extensions: in-process plugin modules (manifest `hostModule`). Used by
// the server entrypoint to mount their router, activate them at boot and tear
// them down on shutdown.
export {
  activateHostExtensions,
  deactivateHostExtensions,
  getHostExtensionRouter,
  activeHostExtensionNames,
} from './services/plugin-host-extensions.service.js';
export type { PluginHost, PluginHostModule } from './services/plugin-host-extensions.service.js';
// pluginsRoutes: used by the server entrypoint to mount protected plugin-management endpoints.
export { pluginsRoutes } from './plugins.module.js';

// startEnabledPluginServers: used by the server entrypoint to start enabled plugin subprocesses.
export { startEnabledPluginServers } from './plugin-process.service.js';
// stopAllPlugins: used by the server entrypoint to stop plugin subprocesses during shutdown.
export { stopAllPlugins } from './plugin-process.service.js';
// getPluginPort: used by WebSocket setup in the server entrypoint to proxy plugin connections.
export { getPluginPort } from './plugin-process.service.js';

// scanPlugins/getPluginsDir/getPluginDir/validateManifest: plugin registry used by the
// server entrypoint (host-extension activation) and the plugins routes.
export { scanPlugins, getPluginsDir, getPluginDir, validateManifest } from './plugin-registry.service.js';
