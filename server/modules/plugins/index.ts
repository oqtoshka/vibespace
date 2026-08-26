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
