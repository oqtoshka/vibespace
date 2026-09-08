/** Deployment routes expose only these public startup settings, never raw env.
 * JSON is escaped for safe JavaScript delivery even with operator-provided labels.
 */
export function deploymentConfigScript(): string {
  const config = {
    title: process.env.VS_APP_TITLE || undefined,
    enabledProviders: process.env.VS_ENABLED_PROVIDERS?.split(',').map(value => value.trim()),
    opencodeDefaultModel: process.env.VS_OPENCODE_DEFAULT_MODEL || undefined,
    opencodeLabel: process.env.VS_OPENCODE_LABEL || 'OpenCode',
    opencodeAvatar: process.env.VS_OPENCODE_AVATAR || '',
    workspaceServices: process.env.VS_WORKSPACE_SERVICES === 'true',
  };
  return `window.__VIBESPACE_CONFIG__=${JSON.stringify(config).replace(/</g, '\\u003c')};`;
}
