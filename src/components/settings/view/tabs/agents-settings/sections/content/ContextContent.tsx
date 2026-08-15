import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Gauge, Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../../../../shared/view/ui';
import { api } from '../../../../../../../utils/api';

type CompactionConfig = {
  auto: boolean;
  prune: boolean;
  tailTurns: number | null;
  preserveRecentTokens: number | null;
  reserved: number | null;
};

type ModelLimit = {
  context: number;
  input: number | null;
  output: number;
};

type CompactionSettings = {
  configPath: string;
  compaction: CompactionConfig;
  model: string | null;
  limit: ModelLimit | null;
  compactAtTokens: number | null;
  reservedHonored: boolean;
};

const formatTokens = (value: number): string => value.toLocaleString();

/** An empty field means "unset"; anything else has to be a whole token count. */
const parseTokenDraft = (draft: string): number | null | undefined => {
  const trimmed = draft.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed.replace(/[\s,_]/g, ''));
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const tokenDraft = (value: number | null): string => (value === null ? '' : String(value));

type NumberFieldProps = {
  label: string;
  description: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

function NumberField({ label, description, placeholder, value, onChange, disabled }: NumberFieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <Input
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 max-w-[16rem]"
      />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

type CheckboxFieldProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
};

function CheckboxField({ label, description, checked, onChange }: CheckboxFieldProps) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-input bg-card text-primary focus:ring-2 focus:ring-primary"
      />
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </label>
  );
}

/**
 * OpenCode's context window and when it compacts.
 *
 * The one thing worth knowing before reading the save path: `compaction.reserved`
 * is the only knob that moves the compaction threshold, and OpenCode applies it
 * ONLY to models that declare an input ceiling (`limit.input`). For a custom
 * provider that declares just `context` and `output`, setting `reserved` writes
 * a value that is read and then ignored. So "compact at N tokens" is saved as an
 * input ceiling plus the headroom below it, and models this config does not own
 * are shown as read-only rather than given a control that silently does nothing.
 */
export default function ContextContent() {
  const { t } = useTranslation('settings');

  const [settings, setSettings] = useState<CompactionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [auto, setAuto] = useState(true);
  const [prune, setPrune] = useState(false);
  const [compactAtDraft, setCompactAtDraft] = useState('');
  const [preserveDraft, setPreserveDraft] = useState('');
  const [tailTurnsDraft, setTailTurnsDraft] = useState('');

  const applySettings = useCallback((next: CompactionSettings) => {
    setSettings(next);
    setAuto(next.compaction.auto);
    setPrune(next.compaction.prune);
    setCompactAtDraft(tokenDraft(next.compactAtTokens));
    setPreserveDraft(tokenDraft(next.compaction.preserveRecentTokens));
    setTailTurnsDraft(tokenDraft(next.compaction.tailTurns));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.openCodeCompaction();
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message || body?.error || 'Failed to read OpenCode settings');
      }
      applySettings(body.data as CompactionSettings);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  const limit = settings?.limit ?? null;

  const compactAtPercent = useMemo(() => {
    const parsed = parseTokenDraft(compactAtDraft);
    if (!limit || !parsed || limit.context <= 0) return null;
    return Math.round((parsed / limit.context) * 100);
  }, [compactAtDraft, limit]);

  const handleSave = async () => {
    if (!settings || !limit) return;

    const compactAt = parseTokenDraft(compactAtDraft);
    const preserve = parseTokenDraft(preserveDraft);
    const tailTurns = parseTokenDraft(tailTurnsDraft);

    if (compactAt === undefined || preserve === undefined || tailTurns === undefined) {
      setError(t('contextSettings.errors.notANumber', {
        defaultValue: 'Those fields take a whole number of tokens, or nothing at all.',
      }));
      return;
    }

    if (compactAt !== null && compactAt >= limit.context) {
      setError(t('contextSettings.errors.aboveWindow', {
        defaultValue: 'Compaction has to start below the window itself — otherwise it never starts.',
        context: formatTokens(limit.context),
      }));
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      let inputCeiling = limit.input;

      // Declaring the ceiling is what makes `reserved` do anything. It is only
      // written when a threshold is actually being set, so a config that never
      // needed it does not grow the field.
      if (compactAt !== null && !inputCeiling && settings.model) {
        const limitResponse = await api.saveOpenCodeModelInputLimit(settings.model, limit.context);
        const limitBody = await limitResponse.json();
        if (!limitResponse.ok) {
          throw new Error(
            limitBody?.error?.message
              || t('contextSettings.errors.modelNotOwned', {
                defaultValue:
                  'This model comes from OpenCode\'s own catalog, so its limits cannot be edited here.',
              }),
          );
        }
        inputCeiling = limit.context;
      }

      const response = await api.saveOpenCodeCompaction({
        model: settings.model,
        auto,
        prune,
        preserveRecentTokens: preserve,
        tailTurns,
        // The stored setting is the headroom left free, not the trigger point.
        reserved: compactAt === null || !inputCeiling ? null : Math.max(1, inputCeiling - compactAt),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error?.message || body?.error || 'Failed to save OpenCode settings');
      }

      applySettings(body.data as CompactionSettings);
      setSaved(true);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('contextSettings.loading', { defaultValue: 'Reading OpenCode configuration…' })}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('contextSettings.retry', { defaultValue: 'Try again' })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Gauge className="h-5 w-5 text-blue-500" />
        <div>
          <h3 className="text-lg font-medium text-foreground">
            {t('contextSettings.title', { defaultValue: 'Context & compaction' })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {settings.model
              ? t('contextSettings.subtitle', {
                defaultValue: 'For {{model}}, from {{path}}',
                model: settings.model,
                path: settings.configPath,
              })
              : t('contextSettings.noModel', {
                defaultValue: 'No default model is set in {{path}}, so the window is unknown.',
                path: settings.configPath,
              })}
          </p>
        </div>
      </div>

      {limit && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('contextSettings.window', { defaultValue: 'Context window' })}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">{formatTokens(limit.context)}</div>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('contextSettings.maxOutput', { defaultValue: 'Max output' })}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">{formatTokens(limit.output)}</div>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('contextSettings.compactsAt', { defaultValue: 'Compacts at' })}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">
              {settings.compactAtTokens ? formatTokens(settings.compactAtTokens) : '—'}
            </div>
          </div>
        </div>
      )}

      {!limit && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          {t('contextSettings.unknownWindow', {
            defaultValue:
              'OpenCode did not report a window for this model, so there is nothing to measure against and compaction cannot be timed.',
          })}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border p-4">
        <CheckboxField
          label={t('contextSettings.auto.label', { defaultValue: 'Compact automatically' })}
          description={t('contextSettings.auto.description', {
            defaultValue:
              'Summarise the conversation when it reaches the threshold below. Turned off, a full window becomes an error instead.',
          })}
          checked={auto}
          onChange={setAuto}
        />

        <NumberField
          label={t('contextSettings.compactAt.label', { defaultValue: 'Compact when context reaches' })}
          description={
            compactAtPercent !== null
              ? t('contextSettings.compactAt.descriptionWithPercent', {
                defaultValue: '{{percent}}% of the window. Leave empty for OpenCode\'s own timing.',
                percent: compactAtPercent,
              })
              : t('contextSettings.compactAt.description', {
                defaultValue: 'Tokens. Leave empty for OpenCode\'s own timing.',
              })
          }
          placeholder={limit ? formatTokens(Math.floor(limit.context * 0.8)) : '0'}
          value={compactAtDraft}
          onChange={(value) => {
            setCompactAtDraft(value);
            setSaved(false);
          }}
          disabled={!auto || !limit}
        />

        {!settings.reservedHonored && settings.model && (
          <div className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <span>
              {t('contextSettings.reservedInert', {
                defaultValue:
                  'This model declares no input ceiling, so OpenCode currently ignores any threshold and compacts at window minus max output. Saving a threshold declares the ceiling for you, which is what makes the setting take effect.',
              })}
            </span>
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-border p-4">
        <div className="text-sm font-medium text-foreground">
          {t('contextSettings.afterCompaction', { defaultValue: 'What survives a compaction' })}
        </div>

        <NumberField
          label={t('contextSettings.preserve.label', { defaultValue: 'Keep recent messages verbatim' })}
          description={t('contextSettings.preserve.description', {
            defaultValue: 'Tokens of the most recent conversation left uncompressed. Empty means a quarter of the window.',
          })}
          placeholder={t('contextSettings.placeholderDefault', { defaultValue: 'default' })}
          value={preserveDraft}
          onChange={(value) => {
            setPreserveDraft(value);
            setSaved(false);
          }}
        />

        <NumberField
          label={t('contextSettings.tailTurns.label', { defaultValue: 'Keep last turns' })}
          description={t('contextSettings.tailTurns.description', {
            defaultValue: 'A hard floor on how many recent turns stay verbatim, whatever the token budget says.',
          })}
          placeholder={t('contextSettings.placeholderDefault', { defaultValue: 'default' })}
          value={tailTurnsDraft}
          onChange={(value) => {
            setTailTurnsDraft(value);
            setSaved(false);
          }}
        />

        <CheckboxField
          label={t('contextSettings.prune.label', { defaultValue: 'Drop old tool output instead of summarising it' })}
          description={t('contextSettings.prune.description', {
            defaultValue: 'Cheaper and faster, but the agent loses what those tools actually returned.',
          })}
          checked={prune}
          onChange={(value) => {
            setPrune(value);
            setSaved(false);
          }}
        />
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <Button onClick={() => void handleSave()} disabled={saving} size="sm">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('contextSettings.save', { defaultValue: 'Save' })}
        </Button>
        {saved && !saving && (
          <span className="text-sm text-green-600 dark:text-green-400">
            {t('contextSettings.savedNotice', { defaultValue: 'Saved to opencode.json' })}
          </span>
        )}
      </div>
    </div>
  );
}
