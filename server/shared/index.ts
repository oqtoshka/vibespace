// Shared contracts and helpers consumed by provider adapters and other modules.
export type { IProviderSessions } from './interfaces.js';
export type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage, ProviderRunFunction, ProviderRuntimeWriter } from './types.js';
export { buildCodexTokenBudget } from './codex-token-usage.js';
// OIDC, manager registry and worker auth share the exact managed identity rules.
export { isManagedUsername } from './utils.js';

// The providers token-usage service reads OpenCode spend with the same rules as the runners.
export { lookupOpenCodeTokenUsage } from './opencode-token-usage.js';
export {
  createCompactBoundaryMessage,
  looksLikeCompactSummary,
  VIBESPACE_OPENCODE_COMPACTIONS_FIELD,
} from './compaction.js';
export { extractToolResultImages, parseFilesInputTag, toImageAttachments } from './image-attachments.js';
export { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from './utils.js';

// Native chat shares provider identity and server-validated attachment formatting.
export type { LLMProvider, AuthenticatedWebSocketRequest } from './types.js';
export { appendFilesInputTag, isImageAttachmentDescriptor } from './image-attachments.js';

// Runtime dispatch shares provider contracts through the shared barrel.
export type { IProvider } from './interfaces.js';
export type { ProviderModelsDefinition, ProviderPermissionDecision, ProviderRuntimeContext } from './types.js';

// Database session identity normalization.
export { normalizeProjectPath } from './utils.js';
export type { SessionNameSource } from './utils.js';
export { sessionAvatarUrl } from './utils.js';

// Legacy and native-workspace diagram previews share source encoding/rendering.
export { encodePlantUmlSource, inlinePlantUmlIncludes, renderDbmlToSvg } from './utils.js';

// Workspace policy and file-tree consume filesystem contracts and path guards.
export type { FileTreeDirectoryEntry, FileTreeNode, FileTreeServiceDependencies, FileTreeServices, FileTreeUploadedFile, FileTreeFileSystem, FileTreeLogger, FileTreeProjectGateway, FileTreeWorkspaceGateway } from './types.js';
export { AppError, FORBIDDEN_WORKSPACE_PATHS, WORKSPACES_ROOT, validateWorkspacePath } from './utils.js';

export { readCodexPlanState, findCodexRolloutPath } from './utils.js';
// Per-turn task continuation reads provider ledgers through the shared contract.
export { readCursorTaskState } from './cursor-todo-ledger.js';
export { readOpenCodeTaskState } from './opencode-todo-ledger.js';
export { WAITING_ON_USER_MARKER } from './waiting-on-user.js';
export { readExternalTaskLedger, registerTaskLedgerSource } from './task-ledger-sources.js';
// Providers' dedicated diagnostic peer applies the existing server-secret filter.
export { buildAgentEnv, collectAgentLaunchExtras, registerAgentLaunchContributor, parseStoredLaunchOptions } from './agent-env.js';
// Codex/OpenCode fence launch instructions in the first prompt; title, recap and topic helpers strip them.
// The plugins module registers the legacy (unmarked) preamble headings enabled plugins declare.
export { prependLaunchInstructions, registerLegacyLaunchPreambleHeadings, stripLaunchInstructions } from './utils.js';
export type { CodexDiagnosticScope, CodexDiagnosticHandle, CodexDiagnosticLease } from './types.js';

// Recap and host plugins share the explicit, bounded external-topic authority contract.
export { readSessionTopicAuthority, registerSessionTopicAuthoritySource } from './session-topic-authority.js';
export type { SessionTopicAuthorityContext, SessionTopicAuthoritySource } from './types.js';

// Claude's session provider shares finite-number parsing and rewind result contracts.
export { readFiniteNumber } from './utils.js';
export type { RewindResult } from './types.js';
