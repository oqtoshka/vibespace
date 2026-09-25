const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_VOICE_SETTINGS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_voice_settings (
    user_id INTEGER PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    custom_name TEXT,
    -- Where \`custom_name\` came from, so a better title can replace a weaker
    -- one without ever clobbering an explicit rename: 'user' (renamed by hand)
    -- > 'ai' (a provider-generated title) > 'derived' (first/last prompt or
    -- another mechanical fallback). NULL on rows that predate this column.
    name_source TEXT,
    -- A sentence or two on what the session is actually doing, regenerated in
    -- the background as the conversation moves (see session-recap.service).
    -- Distinct from \`custom_name\`, which is the few-word label the lists show.
    recap TEXT,
    -- Transcript size the recap was generated from, so a session that has not
    -- moved since is not re-summarised on every idle tick.
    recap_message_count INTEGER,
    project_path TEXT,
    jsonl_path TEXT,
    worktree_path TEXT,
    -- Model, reasoning effort, and permission mode this session runs with.
    -- Written on every send so browserless follow-up messages can preserve the
    -- same runtime configuration instead of falling back to provider defaults.
    model TEXT,
    effort TEXT,
    permission_mode TEXT,
    isArchived BOOLEAN DEFAULT 0,
    -- 1 while this session only backs a \`/btw\` side question. Such a session is
    -- real and resumable but stays out of the session lists; "branching out"
    -- a btw clears the flag and the session becomes an ordinary one.
    is_side INTEGER DEFAULT 0,
    -- 1 when the session was started private: every harness process that runs
    -- it carries the private-variant env, so no presence reporter ever speaks for
    -- it, and VibeSpace's own notifications and recap generator skip it.
    -- Decided at creation and never changed — a session that has reported
    -- once cannot become private after the fact.
    is_private INTEGER DEFAULT 0,
    -- The launch options the session was created with, as JSON: option id →
    -- value, for options declared by host plugins. The host stores the choice
    -- and hands it to every harness launch; what an option means is the
    -- declaring plugin's business. Decided at creation and never changed,
    -- exactly like is_private. NULL when none were chosen.
    launch_options TEXT,
    -- The session a side question was asked from, for native side questions
    -- (FEAT-SESSION-030). Kept after promotion as provenance; NULL otherwise.
    parent_session_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

/**
 * Persistent lexical session index. The ordinary table tracks the source
 * fingerprint for incremental rebuilds. Searchable text is compressed in the
 * document table and indexed by a contentless FTS5 table, so SQLite does not
 * keep a second uncompressed copy of every transcript and tool result.
 *
 * User and project ids are deliberately copied onto every document. Search
 * always supplies the active user id, so a future multi-user database cannot
 * accidentally turn this local index into a cross-tenant side channel.
 */
export const SESSION_SEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_search_state (
    session_id TEXT PRIMARY KEY NOT NULL,
    source_fingerprint TEXT NOT NULL,
    indexed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_search_documents (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project_id TEXT,
    project_path TEXT,
    provider TEXT NOT NULL,
    archived INTEGER NOT NULL,
    occurred_at TEXT,
    message_id TEXT,
    role TEXT,
    kind TEXT NOT NULL,
    display_title TEXT NOT NULL,
    display_summary TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    compressed_content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_search_documents_session ON session_search_documents(session_id);
CREATE INDEX IF NOT EXISTS idx_session_search_documents_filters
    ON session_search_documents(user_id, archived, provider, project_id, occurred_at);

CREATE VIRTUAL TABLE IF NOT EXISTS session_search_fts USING fts5(
    title,
    summary,
    content,
    content = '',
    contentless_delete = 1,
    detail = column,
    tokenize = 'unicode61 remove_diacritics 2'
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// Public, unguessable share links to project files. `file_path` is the absolute
// resolved path on disk; the public routes re-validate it against the project
// root before serving. `expires_at` NULL means permanent (until the file is
// deleted). Project deletion isn't FK-cascaded — a dead project_id just resolves
// to nothing and the link 404s.
export const FILE_SHARES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS file_shares (
    share_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_by_user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    view_count INTEGER DEFAULT 0,
    last_accessed DATETIME,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Persistent custom-model library used by the Providers module.
 *
 * Only user-created models are stored here. Predefined models remain source-
 * controlled in each provider's `-models.provider.ts` adapter so they can be
 * updated without migrating application data. `model_id` is unique only within
 * a provider because different CLIs can accept the same identifier.
 */
export const PROVIDER_MODELS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'cursor', 'codex', 'opencode')),
    model_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, model_id)
);
`;

/**
 * Durable outbox for cross-session peer messages (plugin host
 * `peerOutbox`). One row per (sender, requestId): that pair is the idempotency
 * key, so a replay reads the original row instead of creating a second one.
 * `status`: `pending` (persisted, never handed to a runtime), `dispatched`
 * (marked *before* the runtime is called, so after a crash its fate is
 * unknown and it is never replayed automatically), `cancelled` (with a
 * `reason`; never dispatched). Rows are kept, not deleted, so a replay can
 * always report the original outcome.
 */
export const PEER_OUTBOX_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS peer_outbox (
    sender_session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    recipient_session_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    content TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'cancelled')),
    reason TEXT,
    accepted_at TEXT NOT NULL,
    dispatched_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (sender_session_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_peer_outbox_recipient_status
ON peer_outbox(recipient_session_id, status, accepted_at);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${USER_VOICE_SETTINGS_TABLE_SCHEMA_SQL}

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${SESSION_SEARCH_SCHEMA_SQL}

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${FILE_SHARES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_file_shares_project_file ON file_shares(project_id, file_path);
${PROVIDER_MODELS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_provider_models_provider_order
ON provider_models(provider, sort_order, id);
${PEER_OUTBOX_TABLE_SCHEMA_SQL}
`;
