import { createContext, useContext } from 'react';

import type { PendingPermissionRequest, PermissionMode } from '../components/chat/types/types';

export interface PermissionContextValue {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: {
      allow?: boolean;
      message?: string;
      rememberEntry?: string | null;
      updatedInput?: unknown;
      /**
       * Mode the session should run in from this decision onwards. Only
       * meaningful for ExitPlanMode: approving it ends plan mode, and the
       * runtime has to be told what to switch to. See PlanDisplay.
       */
      permissionMode?: PermissionMode;
    },
  ) => void;
  /** Composer's current mode — what "Build" should hand the runtime. */
  permissionMode: PermissionMode | string;
  setPermissionMode: (mode: PermissionMode) => void;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;
