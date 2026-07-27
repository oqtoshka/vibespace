import React from 'react';
import { ChevronsUpDown, FileText } from 'lucide-react';

import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  Button,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Shimmer,
} from '../../../../shared/view/ui';
import { usePermission } from '../../../../contexts/PermissionContext';
import type { PermissionMode } from '../../types/types';

import { MarkdownContent } from './ContentRenderers';

interface PlanDisplayProps {
  title: string;
  content: string;
  defaultOpen?: boolean;
  isStreaming?: boolean;
  showRawParameters?: boolean;
  rawContent?: string;
  toolName: string;
  toolId?: string;
}

export const PlanDisplay: React.FC<PlanDisplayProps> = ({
  title,
  content,
  defaultOpen = false,
  isStreaming = false,
  showRawParameters = false,
  rawContent,
  toolName: _toolName,
}) => {
  const permissionCtx = usePermission();

  const pendingRequest = permissionCtx?.pendingPermissionRequests.find(
    (r) => r.toolName === 'ExitPlanMode' || r.toolName === 'exit_plan_mode'
  );

  // Approving ExitPlanMode ends plan mode, so the runtime needs to be told what
  // to run as from here on. It used to be told nothing and fell back to
  // `default`, which silently discarded a mode the user had already picked:
  // switch to bypassPermissions while the plan is up, press Build, and the
  // build phase would start prompting for every tool.
  //
  // The composer's mode is that choice. If it is still `plan` — the user never
  // touched it — `default` is the honest landing spot, and the composer is
  // moved off `plan` too so the pill matches what the session is actually doing.
  const handleBuild = () => {
    if (!pendingRequest || !permissionCtx) return;

    const buildMode = permissionCtx.permissionMode === 'plan'
      ? 'default'
      : (permissionCtx.permissionMode as PermissionMode);

    permissionCtx.handlePermissionDecision(pendingRequest.requestId, {
      allow: true,
      permissionMode: buildMode,
    });

    if (permissionCtx.permissionMode === 'plan') {
      permissionCtx.setPermissionMode('default');
    }
  };

  const handleRevise = () => {
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, {
        allow: false,
        message: 'User asked to revise the plan',
      });
    }
  };

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card className="my-1 flex flex-col shadow-none">
        {/* Header — always visible */}
        <CardHeader className="flex flex-row items-start justify-between space-y-0 px-4 pb-0 pt-4">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold">
              {isStreaming ? <Shimmer>{title}</Shimmer> : title}
            </CardTitle>
          </div>
          <CollapsibleTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <ChevronsUpDown className="h-4 w-4" />
            <span className="sr-only">Toggle plan</span>
          </CollapsibleTrigger>
        </CardHeader>

        {/* Collapsible content */}
        <CollapsibleContent>
          <CardContent className="px-4 pb-4 pt-3">
            {content ? (
              <MarkdownContent
                content={content}
                className="prose prose-sm max-w-none dark:prose-invert"
              />
            ) : isStreaming ? (
              <div className="py-2">
                <Shimmer>Generating plan...</Shimmer>
              </div>
            ) : null}

            {showRawParameters && rawContent && (
              <Collapsible className="mt-3">
                <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
                  <svg
                    className="h-2.5 w-2.5 flex-shrink-0 transition-transform duration-150 data-[state=open]:rotate-90"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  raw params
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-border/40 bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                    {rawContent}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        </CollapsibleContent>

        {/* Footer — always visible when permission is pending */}
        {pendingRequest && (
          <CardFooter className="justify-end gap-2 border-t border-border/40 px-4 pb-3 pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRevise}
              className="text-muted-foreground"
            >
              Revise
            </Button>
            <Button size="sm" onClick={handleBuild}>
              Build{' '}
              <kbd className="ml-1 rounded bg-primary-foreground/20 px-1 py-0.5 font-mono text-[10px]">
                ⌘↩
              </kbd>
            </Button>
          </CardFooter>
        )}
      </Card>
    </Collapsible>
  );
};
