import type { HostRunLease } from '@/modules/plugins/services/plugin-host-extensions.service.js';

/** What the adapter needs of the run registry (`chatRunRegistry`). */
type AdmissionRegistry = {
  reserveAdmission(input: {
    appSessionId: string;
    providerSessionId: string;
    resourceId: string;
    generation: string;
    ttlMs: number;
  }): { expiresAt: number; release: () => void } | null;
};

/**
 * Builds `host.runs.reserve` over the run registry's turn-admission reservation,
 * for the Janitor's resource cleanup (#119/#203).
 *
 * The lease attests `coversAllRunStarts: true`. That is the operator's decision
 * of 2026-09-24, not a technical absolute: every turn VibeSpace starts is
 * refused and deferred under the lease (chat.send → RUN_ADMISSION_RESERVED and a
 * client re-queue; queue drain, peer outbox, Claude auto-resume and open-task
 * nudge wait for its end), but a native CLI resumed from a terminal runs outside
 * this process and cannot be refused. The operator accepted that gap because the
 * Janitor only ever acts for VibeSpace-created briefing sessions (enforced by the
 * plugin's janitor scope), which are driven from VibeSpace.
 *
 * Anything malformed is refused by the registry (it validates every field), so a
 * null here always means "no lease", never a partial grant.
 */
export function createPluginRunReservation(registry: AdmissionRegistry) {
  return (sessionId: string, input: unknown): HostRunLease | null => {
    const request = (input ?? {}) as {
      providerSessionId?: unknown;
      purpose?: unknown;
      resource?: { id?: unknown; generation?: unknown } | null;
      ttlMs?: unknown;
    };
    const providerSessionId = request.providerSessionId;
    const resourceId = request.resource?.id;
    const generation = request.resource?.generation;
    if (typeof sessionId !== 'string' || typeof providerSessionId !== 'string'
      || typeof resourceId !== 'string' || typeof generation !== 'string' || typeof request.ttlMs !== 'number') {
      return null;
    }
    const grant = registry.reserveAdmission({
      appSessionId: sessionId,
      providerSessionId,
      resourceId,
      generation,
      ttlMs: request.ttlMs,
    });
    if (!grant) {
      return null;
    }
    return {
      sessionId,
      providerSessionId,
      purpose: typeof request.purpose === 'string' ? request.purpose : '',
      resource: { id: resourceId, generation },
      expiresAt: grant.expiresAt,
      coversAllRunStarts: true,
      release: grant.release,
    };
  };
}
