import type { LLMProvider } from '../../../types/app';

type SessionCreationRequestInput = {
  provider: LLMProvider;
  projectPath: string;
  isPrivate: boolean;
  /** Plugin-declared launch options chosen for this session (option id → value). */
  launchOptions?: Record<string, unknown> | null;
  initialMessage: string;
};

/** Builds the allocation request for a new chat session. */
export function buildSessionCreationRequest({
  provider,
  projectPath,
  isPrivate,
  launchOptions = null,
  initialMessage,
}: SessionCreationRequestInput) {
  return {
    provider,
    projectPath,
    private: isPrivate,
    // Both flags are read once by the launch and fixed after (see the server
    // route); an ordinary session sends neither.
    ...(launchOptions && Object.keys(launchOptions).length ? { launchOptions } : {}),
    // Seed a provisional title before the provider run starts. The background
    // recap may replace it later, but a long first turn should not be untitled.
    initialMessage,
  };
}
