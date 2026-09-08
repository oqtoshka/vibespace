/** Verify the requested model before OpenCode admits a prompt. Its v2 runtime
 * otherwise drops unavailable-model turns without a terminal SSE event.
 */
export function assertOpenCodeServerModel(catalog: unknown, model: { providerID: string; id: string }): void {
  if (!Array.isArray(catalog) || !catalog.some((entry) => entry?.providerID === model.providerID && entry?.id === model.id)) {
    throw new Error(`OpenCode runtime model unavailable: ${model.providerID}/${model.id}. Check the OpenCode server configuration.`);
  }
}
