import type { LLMProvider } from '../../../types/app';

type SessionCreationRequestInput = {
  provider: LLMProvider;
  projectPath: string;
  isPrivate: boolean;
  /** Briefing mode, and whether a plan is wanted before any work. */
  briefing?: { needsPlan: boolean } | null;
  initialMessage: string;
};

/** Builds the allocation request for a new chat session. */
export function buildSessionCreationRequest({
  provider,
  projectPath,
  isPrivate,
  briefing = null,
  initialMessage,
}: SessionCreationRequestInput) {
  return {
    provider,
    projectPath,
    private: isPrivate,
    // Both flags are read once by the launch and fixed after (see the server
    // route); an ordinary session sends neither.
    ...(briefing ? { briefing: true, needsPlan: briefing.needsPlan } : {}),
    // Seed a provisional title before the provider run starts. The background
    // recap may replace it later, but a long first turn should not be untitled.
    initialMessage,
  };
}
