import { Bell, BellOff, BellRing, Loader2, Play, Send, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import { playChatCompletionSound } from '../../../../utils/notificationSound';
import type { NotificationPreferencesState } from '../../types/types';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  onSaveTelegramToken: (token: string) => Promise<boolean>;
  onSendTelegramTest: (botToken: string, chatId: string) => Promise<{ ok: boolean; error?: string }>;
  pushPermission: NotificationPermission | 'unsupported';
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  onEnablePush: () => void;
  onDisablePush: () => void;
};

export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  onSaveTelegramToken,
  onSendTelegramTest,
  pushPermission,
  isPushSubscribed,
  isPushLoading,
  onEnablePush,
  onDisablePush,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';

  const telegram = notificationPreferences.telegram;
  const [tokenDraft, setTokenDraft] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState('');

  const handleSaveToken = async () => {
    const token = tokenDraft.trim();
    if (!token || savingToken) return;
    setSavingToken(true);
    const ok = await onSaveTelegramToken(token);
    setSavingToken(false);
    if (ok) setTokenDraft('');
  };

  const handleSendTest = async () => {
    if (testState === 'sending') return;
    setTestState('sending');
    setTestError('');
    const result = await onSendTelegramTest(tokenDraft.trim(), telegram.chatId.trim());
    if (result.ok) {
      setTestState('ok');
    } else {
      setTestState('error');
      setTestError(result.error || '');
    }
  };

  const telegramConfigured = telegram.botTokenSet || tokenDraft.trim().length > 0;
  const canTest = telegramConfigured && telegram.chatId.trim().length > 0 && testState !== 'sending';

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="w-5 h-5 text-blue-600" />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <h4 className="font-medium text-foreground">{t('notifications.webPush.title')}</h4>
        {!pushSupported ? (
          <p className="text-sm text-muted-foreground">{t('notifications.webPush.unsupported')}</p>
        ) : pushDenied ? (
          <p className="text-sm text-muted-foreground">{t('notifications.webPush.denied')}</p>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={isPushLoading}
              onClick={() => {
                if (isPushSubscribed) {
                  onDisablePush();
                } else {
                  onEnablePush();
                }
              }}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isPushSubscribed
                  ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                  : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
              }`}
            >
              {isPushLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isPushSubscribed ? (
                <BellOff className="w-4 h-4" />
              ) : (
                <BellRing className="w-4 h-4" />
              )}
              {isPushLoading
                ? t('notifications.webPush.loading')
                : isPushSubscribed
                  ? t('notifications.webPush.disable')
                  : t('notifications.webPush.enable')}
            </button>
            {isPushSubscribed && (
              <span className="text-sm text-green-600 dark:text-green-400">
                {t('notifications.webPush.enabled')}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-blue-600" />
            <h4 className="font-medium text-foreground">
              {t('notifications.telegram.title', { defaultValue: 'Telegram' })}
            </h4>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('notifications.telegram.description', {
              defaultValue:
                'Send a Telegram message when a run finishes, fails, or needs your input. Uses the event toggles below.',
            })}
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={telegram.enabled}
            onChange={(event) =>
              onNotificationPreferencesChange({
                ...notificationPreferences,
                telegram: { ...telegram, enabled: event.target.checked },
              })
            }
            className="h-4 w-4"
          />
          {t('notifications.telegram.enabled', { defaultValue: 'Enable Telegram notifications' })}
        </label>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">
            {t('notifications.telegram.chatId', { defaultValue: 'Chat ID' })}
          </label>
          <input
            type="text"
            value={telegram.chatId}
            onChange={(event) =>
              onNotificationPreferencesChange({
                ...notificationPreferences,
                telegram: { ...telegram, chatId: event.target.value },
              })
            }
            placeholder="123456789"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">
            {t('notifications.telegram.botToken', { defaultValue: 'Bot token' })}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder={
                telegram.botTokenSet
                  ? t('notifications.telegram.tokenSet', {
                      defaultValue: 'Saved ({{hint}}) — type to replace',
                      hint: telegram.botTokenHint,
                    })
                  : '123456:ABC-DEF...'
              }
              autoComplete="off"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!tokenDraft.trim() || savingToken}
              onClick={handleSaveToken}
            >
              {savingToken ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {t('notifications.telegram.saveToken', { defaultValue: 'Save token' })}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={!canTest} onClick={handleSendTest}>
            {testState === 'sending' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {t('notifications.telegram.test', { defaultValue: 'Send test' })}
          </Button>
          {testState === 'ok' && (
            <span className="text-sm text-green-600 dark:text-green-400">
              {t('notifications.telegram.testOk', { defaultValue: 'Sent! Check Telegram.' })}
            </span>
          )}
          {testState === 'error' && (
            <span className="text-sm text-red-600 dark:text-red-400">
              {t('notifications.telegram.testFailed', { defaultValue: 'Failed' })}
              {testError ? `: ${testError}` : ''}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-blue-600" />
              <h4 className="font-medium text-foreground">
                {t('notifications.sound.title', { defaultValue: 'Sound' })}
              </h4>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('notifications.sound.description', {
                defaultValue: 'Play a short tone when a chat run finishes.',
              })}
            </p>
          </div>

          <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.channels.sound}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  channels: {
                    ...notificationPreferences.channels,
                    sound: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.sound.enabled', { defaultValue: 'Enabled' })}
          </label>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void playChatCompletionSound({ force: true });
          }}
        >
          <Play className="h-4 w-4" />
          {t('notifications.sound.test', { defaultValue: 'Test sound' })}
        </Button>
      </div>

      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <h4 className="font-medium text-foreground">{t('notifications.events.title')}</h4>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.actionRequired}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    actionRequired: event.target.checked,
                  },
                })
              }
              className="w-4 h-4"
            />
            {t('notifications.events.actionRequired')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.stop}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    stop: event.target.checked,
                  },
                })
              }
              className="w-4 h-4"
            />
            {t('notifications.events.stop')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.error}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    error: event.target.checked,
                  },
                })
              }
              className="w-4 h-4"
            />
            {t('notifications.events.error')}
          </label>
        </div>
      </div>
    </div>
  );
}
