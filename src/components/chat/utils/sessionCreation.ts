import type { LLMProvider } from '../../../types/app';

type SessionCreationRequestInput = {
  provider: LLMProvider;
  projectPath: string;
  isPrivate: boolean;
  initialMessage: string;
};

/** Builds the allocation request for a new chat session. */
export function buildSessionCreationRequest({
  provider,
  projectPath,
  isPrivate,
  initialMessage,
}: SessionCreationRequestInput) {
  return {
    provider,
    projectPath,
    private: isPrivate,
    // Seed a provisional title before the provider run starts. The background
    // recap may replace it later, but a long first turn should not be untitled.
    initialMessage,
  };
}
