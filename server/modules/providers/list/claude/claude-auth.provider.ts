import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

/** The Keychain item Claude Code keeps its OAuth login in on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    // On macOS Claude Code keeps its login in the Keychain and writes no credentials file,
    // so the file alone reported a signed-in Mac as signed out.
    const keychain = await this.readKeychainCredentials();
    if (keychain !== null) {
      try {
        return await this.statusFromCredentials(JSON.parse(keychain), 'keychain', missingCredentialsError);
      } catch {
        // An unreadable Keychain item falls through to the file, as Claude Code does.
      }
    }

    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      return await this.statusFromCredentials(JSON.parse(content), 'credentials_file', missingCredentialsError);
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }

  /**
   * Judges one stored OAuth login. An expired access token with a refresh token is still
   * signed in: Claude Code refreshes it on its next request.
   */
  private async statusFromCredentials(
    parsed: unknown,
    method: string,
    missingCredentialsError: string,
  ): Promise<ClaudeCredentialsStatus> {
    const creds = readObjectRecord(parsed) ?? {};
    const oauth = readObjectRecord(creds.claudeAiOauth);
    const accessToken = readOptionalString(oauth?.accessToken);

    if (!accessToken) {
      return { authenticated: false, email: null, method: null, error: missingCredentialsError };
    }

    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
    const refreshable = Boolean(readOptionalString(oauth?.refreshToken));
    if (expiresAt && Date.now() >= expiresAt && !refreshable) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude login has expired. Run claude /login again.',
      };
    }

    const email = readOptionalString(creds.email)
      ?? readOptionalString(creds.user)
      ?? await this.readAccountEmail();
    return { authenticated: true, email, method };
  }

  /**
   * The signed-in account's e-mail, which Claude Code records in ~/.claude.json rather
   * than beside the token.
   */
  private async readAccountEmail(): Promise<string | null> {
    try {
      const content = await readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
      const account = readObjectRecord(readObjectRecord(JSON.parse(content))?.oauthAccount);
      return readOptionalString(account?.emailAddress) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The Keychain item's secret on macOS, or null elsewhere, when it is absent, or when the
   * Keychain cannot be read. The secret goes to stdout of a child and is never logged.
   */
  private readKeychainCredentials(): Promise<string | null> {
    if (process.platform !== 'darwin') return Promise.resolve(null);
    return new Promise(resolve => {
      execFile(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeout: 5000, encoding: 'utf8' },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    });
  }
}
