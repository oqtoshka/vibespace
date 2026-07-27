import { useCallback, useEffect, useRef, useState } from 'react';

import { transcribeVoice } from '../../../lib/voiceApi';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}

export type VoiceInputState = 'idle' | 'recording' | 'paused' | 'transcribing';

/**
 * Push-to-talk dictation. Records the mic, uploads to /api/voice/transcribe
 * (an OpenAI-compatible speech-to-text backend via the Express proxy), and
 * returns the transcript through onTranscript.
 *
 * Recording can be paused (the take is kept, the mic stops capturing) or
 * cancelled (the take is thrown away). Cancelling also aborts an upload that is
 * already in flight, because "cancel" that still pastes a transcript a few
 * seconds later is not a cancel.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Set on unmount only. Distinct from a user cancel: this one must not touch
  // React state, because the component it belongs to is already gone.
  const unmountedRef = useRef(false);
  const startingRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);
  // Set by cancel() so the `onstop` handler this triggers discards the take
  // instead of transcribing it — `onstop` cannot tell the two callers apart.
  const discardRef = useRef(false);
  // Aborts an upload already in flight when cancel() lands during transcription.
  const uploadAbortRef = useRef<AbortController | null>(null);
  // Not every browser that has MediaRecorder implements pause/resume, so the
  // button is only offered once a live recorder confirms it.
  const [canPause, setCanPause] = useState(false);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      startingRef.current = false;
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;
    startingRef.current = true;
    try {
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        throw Object.assign(new Error('insecure context'), { name: 'InsecureContextError' });
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error('getUserMedia unavailable'), { name: 'UnsupportedError' });
      }
      // iOS Safari rejects the constrained form on some versions (it surfaces as
      // NotAllowedError/OverconstrainedError even when the user granted the mic),
      // so retry bare `{audio:true}` before believing the denial. A genuine denial
      // fails the same way twice without re-prompting.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (constrainedErr) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
          throw constrainedErr;
        });
      }
      if (unmountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      discardRef.current = false;
      setCanPause(typeof rec.pause === 'function' && typeof rec.resume === 'function');

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        stopTracks();
        if (unmountedRef.current) return;
        // Capture and clear the intents for this stop before any async work.
        const shouldSend = sendRef.current;
        const discarded = discardRef.current;
        sendRef.current = false;
        discardRef.current = false;

        // Cancelled: the audio goes nowhere, so there is nothing to upload and
        // no error to report — the user already knows what they did.
        if (discarded) {
          chunksRef.current = [];
          setState('idle');
          return;
        }

        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size < 800) {
          setState('idle');
          onError?.('Recording too short');
          return;
        }
        setState('transcribing');
        const abort = new AbortController();
        uploadAbortRef.current = abort;
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const res = await transcribeVoice(blob, `recording.${ext}`, abort.signal);
          if (!res.ok) throw new Error(`transcribe ${res.status}`);
          const data = await res.json();
          if (unmountedRef.current || abort.signal.aborted) return;
          const text = String(data?.text || '').trim();
          if (text) onTranscript(text, shouldSend);
          else onError?.('No speech detected');
        } catch (e) {
          // An abort is a cancel, not a failure worth a red banner.
          if (!unmountedRef.current && !abort.signal.aborted) {
            onError?.(`Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } finally {
          if (uploadAbortRef.current === abort) uploadAbortRef.current = null;
          // cancel() has already put us back to idle; don't race it.
          if (!unmountedRef.current && !abort.signal.aborted) setState('idle');
        }
      };

      rec.start();
      setState('recording');
    } catch (e) {
      recorderRef.current = null;
      stopTracks();
      if (unmountedRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.name || ''} ${err?.message || e}`.trim();
      if (err?.name === 'InsecureContextError') msg = 'Mic needs HTTPS.';
      else if (err?.name === 'UnsupportedError') msg = 'Mic unsupported by this browser.';
      // Keep the raw name visible: on iOS a granted mic can still land here, and
      // the name is the only way to tell a real denial from a constraint/hardware
      // rejection without a desktop debugger attached to the phone.
      else if (err?.name === 'NotAllowedError') msg = 'Microphone access denied (NotAllowedError).';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      else if (err?.name === 'NotReadableError') msg = 'Mic busy — another app is using it.';
      onError?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
    }
  }, [onTranscript, onError]);

  // Stop recording. Pass { send: true } to auto-send the transcript once it's ready.
  // Guard on the recorder's own state (not React state) so a double tap, or the mic
  // and Send buttons both firing, can't call stop() on an already-inactive recorder.
  const stop = useCallback((opts?: { send?: boolean }) => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      sendRef.current = opts?.send ?? false;
      rec.stop();
    }
  }, []);

  /**
   * Suspends capture, keeping the take. The mic track is deliberately left
   * live: stopping it would end the browser's "recording" indicator, but
   * resuming would need a fresh getUserMedia, which re-prompts on some
   * browsers and starts a second MediaRecorder that cannot append to the first.
   */
  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording' && typeof rec.pause === 'function') {
      rec.pause();
      setState('paused');
    }
  }, []);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === 'paused' && typeof rec.resume === 'function') {
      rec.resume();
      setState('recording');
    }
  }, []);

  /**
   * Throws the take away. Works from every non-idle state: while recording or
   * paused it stops the recorder and marks the resulting `onstop` as a discard;
   * while transcribing it aborts the upload in flight.
   */
  const cancel = useCallback(() => {
    const abort = uploadAbortRef.current;
    if (abort) {
      abort.abort();
      uploadAbortRef.current = null;
    }

    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      discardRef.current = true;
      sendRef.current = false;
      rec.stop();
      // `onstop` clears the chunks and returns to idle.
      return;
    }

    chunksRef.current = [];
    sendRef.current = false;
    discardRef.current = false;
    stopTracks();
    setState('idle');
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording' || state === 'paused') stop();
    else if (state === 'idle') start();
  }, [state, start, stop]);

  return { state, toggle, stop, pause, resume, cancel, canPause };
}
