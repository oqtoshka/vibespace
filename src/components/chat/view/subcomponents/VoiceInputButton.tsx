import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2, Pause, Play, X } from 'lucide-react';

import { PromptInputButton } from '../../../../shared/view/ui';
import type { VoiceInputState } from '../../hooks/useVoiceInput';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  /** False when the browser's MediaRecorder has no pause/resume. */
  canPause?: boolean;
  errorMsg?: string | null;
  className?: string;
};

// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
//
// Cancel and pause sit beside it and appear only once there is a take to act on, so the
// idle composer still shows a single mic. Cancel stays available through transcription —
// that is the slowest part, and the point at which wanting out is most likely.
export default function VoiceInputButton({
  state,
  onToggle,
  onPause,
  onResume,
  onCancel,
  canPause = false,
  errorMsg,
  className,
}: Props) {
  const { t } = useTranslation('chat');

  const isRecording = state === 'recording';
  const isPaused = state === 'paused';
  const isTranscribing = state === 'transcribing';
  const isActive = isRecording || isPaused || isTranscribing;

  const icon = isPaused ? (
    <Square className="text-amber-500" />
  ) : isRecording ? (
    <Square className="text-red-500" />
  ) : isTranscribing ? (
    <Loader2 className="animate-spin" />
  ) : (
    <Mic />
  );

  const toggleTooltip = isPaused
    ? t('voice.stopRecording')
    : isRecording
      ? t('voice.stopRecording')
      : t('voice.input');

  return (
    <span className="relative inline-flex items-center gap-2">
      {errorMsg && (
        <span className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
          {errorMsg}
        </span>
      )}

      {isActive && (
        <PromptInputButton
          tooltip={{ content: t('voice.cancelRecording') }}
          aria-label={t('voice.cancelRecording')}
          className={className}
          onClick={(e: { preventDefault: () => void }) => {
            e.preventDefault();
            onCancel();
          }}
        >
          <X className="text-muted-foreground" />
        </PromptInputButton>
      )}

      {canPause && (isRecording || isPaused) && (
        <PromptInputButton
          tooltip={{ content: isPaused ? t('voice.resumeRecording') : t('voice.pauseRecording') }}
          aria-label={isPaused ? t('voice.resumeRecording') : t('voice.pauseRecording')}
          className={className}
          onClick={(e: { preventDefault: () => void }) => {
            e.preventDefault();
            if (isPaused) onResume();
            else onPause();
          }}
        >
          {isPaused ? <Play /> : <Pause />}
        </PromptInputButton>
      )}

      <PromptInputButton
        tooltip={{ content: toggleTooltip }}
        className={className}
        disabled={isTranscribing}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          onToggle();
        }}
      >
        {icon}
      </PromptInputButton>
    </span>
  );
}
