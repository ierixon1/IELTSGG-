import React, { useEffect, useMemo, useRef, useState } from 'react';
import { UserProfile } from '../types';
import { sendPreppyMessage } from '../services/api';
import { Bot, Lightbulb, Send, Sparkles, User, X } from 'lucide-react';
import { useT } from '../i18n';
import { Badge, Button, cx } from './ui';

interface PreppyAIAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfile;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

const QUICK_PROMPT_KEYS = ['p1', 'p2', 'p3', 'p4'] as const;

function clockLabel(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const PreppyAIAssistant: React.FC<PreppyAIAssistantProps> = ({
  isOpen,
  onClose,
  profile,
}) => {
  const t = useT();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const greeting = useMemo<ChatMessage>(
    () => ({
      id: 'greeting',
      role: 'assistant',
      content: t('preppy.greeting'),
      timestamp: clockLabel(),
    }),
    [t],
  );

  // The greeting follows the interface language, so switching locale mid-chat
  // does not leave a stray English opener above translated replies.
  const thread = messages.length > 0 ? messages : [greeting];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend ?? input).trim();
    if (!text || isLoading) return;

    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: clockLabel(),
    };

    const nextThread = [...thread, userMessage];
    setMessages(nextThread);
    setInput('');
    setIsLoading(true);

    try {
      const reply = await sendPreppyMessage(
        nextThread.map((message) => ({ role: message.role, content: message.content })),
        { targetBand: profile.targetBand, weakSection: profile.weakSection },
      );

      setMessages((previous) => [
        ...previous,
        { id: `a-${Date.now()}`, role: 'assistant', content: reply, timestamp: clockLabel() },
      ]);
    } catch {
      setMessages((previous) => [
        ...previous,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: t('preppy.error'),
          timestamp: clockLabel(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-end bg-ink-950/45 p-2 backdrop-blur-sm sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preppy-title"
    >
      <div className="es-card flex h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0 shadow-[var(--shadow-lg)]">
        <header className="es-ink-surface flex items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-brand-500 text-white">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <h3 id="preppy-title" className="font-display text-base font-bold text-white">
                {t('preppy.title')}
              </h3>
              <p className="text-xs text-white/55">
                {t('preppy.subtitle')} · {t('common.target')} {profile.targetBand.toFixed(1)}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="es-scroll flex items-center gap-2 overflow-x-auto border-b border-ink-100 bg-ink-50 p-3">
          <span className="inline-flex shrink-0 items-center gap-1 text-[0.625rem] font-bold uppercase tracking-[0.1em] text-ink-400">
            <Lightbulb className="h-3 w-3 text-warning-500" />
            {t('preppy.suggested')}
          </span>
          {QUICK_PROMPT_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => handleSend(t(`preppy.prompts.${key}`))}
              disabled={isLoading}
              className="shrink-0 whitespace-nowrap rounded-[var(--radius-pill)] border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:opacity-50"
            >
              {t(`preppy.prompts.${key}`)}
            </button>
          ))}
        </div>

        <div className="es-scroll flex-1 space-y-4 overflow-y-auto bg-white p-4">
          {thread.map((message) => (
            <div
              key={message.id}
              className={cx(
                'flex items-start gap-2.5',
                message.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {message.role === 'assistant' && (
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <Bot className="h-4 w-4" />
                </span>
              )}

              <div
                className={cx(
                  'max-w-[85%] whitespace-pre-wrap rounded-[var(--radius-card)] p-3.5 text-sm leading-relaxed',
                  message.role === 'user'
                    ? 'bg-ink-900 text-white'
                    : 'border border-ink-100 bg-ink-50 text-ink-800',
                )}
              >
                {message.content}
                <span
                  className={cx(
                    'mt-1.5 block text-right text-[0.625rem] tabular',
                    message.role === 'user' ? 'text-white/40' : 'text-ink-400',
                  )}
                >
                  {message.timestamp}
                </span>
              </div>

              {message.role === 'user' && (
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-600">
                  <User className="h-4 w-4" />
                </span>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex items-center gap-2 p-2 text-sm text-ink-400">
              <Sparkles className="h-4 w-4 animate-spin text-brand-500" />
              {t('preppy.thinking')}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2 border-t border-ink-100 bg-ink-50 p-3"
        >
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('preppy.placeholder')}
            aria-label={t('preppy.placeholder')}
            className="flex-1 rounded-[var(--radius-control)] border border-ink-200 bg-white px-4 py-2.5 text-sm text-ink-900 outline-none focus:border-brand-400"
          />
          <Button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="h-10 w-10 shrink-0 p-0"
            aria-label={t('preppy.send')}
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>

        <p className="border-t border-ink-100 bg-white px-4 py-2 text-[0.6875rem] text-ink-400">
          {t('preppy.contextNote')}
        </p>
      </div>
    </div>
  );
};
