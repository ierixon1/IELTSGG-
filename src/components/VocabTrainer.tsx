import React, { useMemo, useState } from 'react';
import { VocabCard } from '../types';
import { Check, Languages, RotateCcw, Sparkles, X } from 'lucide-react';
import { useT } from '../i18n';
import { Badge, Button, Card, Progress, cx } from './ui';
import { MAX_BOX, deckStats, dueCards, reviewCard } from '../utils/vocabEngine';

interface VocabTrainerProps {
  cards: VocabCard[];
  onUpdateCards: (cards: VocabCard[]) => void;
}

/**
 * Spaced-repetition drill over words the learner actually produced.
 *
 * The deck is a by-product of grading: nothing here was chosen from a stock
 * list, so every card is traceable to an essay or a recording.
 */
export const VocabTrainer: React.FC<VocabTrainerProps> = ({ cards, onUpdateCards }) => {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  /** Cards answered in this sitting, so the queue does not re-serve them. */
  const [reviewedThisSession, setReviewedThisSession] = useState<string[]>([]);

  const stats = useMemo(() => deckStats(cards), [cards]);

  const queue = useMemo(
    () => dueCards(cards).filter((card) => !reviewedThisSession.includes(card.id)),
    [cards, reviewedThisSession],
  );

  const current = queue[0];

  const answer = (remembered: boolean) => {
    if (!current) return;

    const updated = reviewCard(current, remembered);
    onUpdateCards(cards.map((card) => (card.id === current.id ? updated : card)));
    setReviewedThisSession((done) => [...done, current.id]);
    setRevealed(false);
  };

  const sessionDone = reviewedThisSession.length;

  return (
    <div className="space-y-6">
      <Card className="es-enter flex flex-col justify-between gap-6 p-6 sm:p-8 md:flex-row md:items-center">
        <div className="max-w-xl">
          <Badge tone="neutral">
            <Languages className="h-3 w-3" />
            {t('vocab.eyebrow')}
          </Badge>
          <h1 className="mt-3.5 text-display-sm text-ink-900">{t('vocab.title')}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-500">{t('vocab.subtitle')}</p>
        </div>

        <dl className="flex shrink-0 gap-6 rounded-[var(--radius-card)] bg-ink-50 px-6 py-5">
          <div>
            <dt className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-ink-400">
              {t('vocab.due')}
            </dt>
            <dd className="mt-1 font-mono text-xl font-bold tabular text-brand-600">{stats.due}</dd>
          </div>
          <div>
            <dt className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-ink-400">
              {t('vocab.total')}
            </dt>
            <dd className="mt-1 font-mono text-xl font-bold tabular text-ink-900">{stats.total}</dd>
          </div>
          <div>
            <dt className="text-[0.625rem] font-bold uppercase tracking-[0.12em] text-ink-400">
              {t('vocab.learned')}
            </dt>
            <dd className="mt-1 font-mono text-xl font-bold tabular text-success-700">
              {stats.learned}
            </dd>
          </div>
        </dl>
      </Card>

      {stats.total === 0 ? (
        <Card className="es-enter p-10 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
            <Sparkles className="h-6 w-6" />
          </span>
          <h2 className="mt-5 font-display text-lg font-bold text-ink-900">
            {t('vocab.emptyTitle')}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-500">
            {t('vocab.emptyBody')}
          </p>
        </Card>
      ) : current ? (
        <div className="es-enter space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-ink-500 tabular">
              {t('vocab.remaining', { count: queue.length })}
            </p>
            <span className="w-40">
              <Progress value={sessionDone / Math.max(1, sessionDone + queue.length)} />
            </span>
          </div>

          <Card className="p-6 sm:p-10">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Badge tone={current.skill === 'writing' ? 'writing' : 'speaking'}>
                {t(`skills.${current.skill}`)}
              </Badge>
              <Badge tone={current.source === 'repetition' ? 'warning' : 'danger'}>
                {t(`vocab.source.${current.source}`)}
              </Badge>
              <span className="text-xs text-ink-400 tabular">
                {t('vocab.box', { box: current.box, max: MAX_BOX })}
              </span>
            </div>

            <p className="mt-7 text-center font-display text-display-md text-ink-900">
              {current.term}
            </p>

            {current.source === 'repetition' && current.note && (
              <p className="mt-2 text-center text-sm text-ink-500">
                {t('vocab.usedTimes', { count: current.note })}
              </p>
            )}

            <p className="mt-3 text-center text-sm text-ink-500">
              {t(`vocab.prompt.${current.source}`)}
            </p>

            {revealed ? (
              <div className="mt-8 space-y-4 border-t border-ink-100 pt-6">
                {current.suggestion && (
                  <div className="rounded-[var(--radius-control)] bg-success-50 p-4 text-center">
                    <p className="text-[0.625rem] font-bold uppercase tracking-[0.1em] text-success-700">
                      {t('vocab.stronger')}
                    </p>
                    <p className="mt-1.5 font-display text-lg font-bold text-success-700">
                      {current.suggestion}
                    </p>
                  </div>
                )}

                {current.source === 'annotation' && current.note && (
                  <p className="text-center text-sm leading-relaxed text-ink-600">{current.note}</p>
                )}

                {current.source === 'repetition' && (
                  <p className="text-center text-sm leading-relaxed text-ink-600">
                    {t('vocab.repetitionAdvice')}
                  </p>
                )}

                <div className="flex flex-col justify-center gap-3 pt-2 sm:flex-row">
                  <Button variant="secondary" onClick={() => answer(false)}>
                    <X className="h-4 w-4 text-danger-500" />
                    {t('vocab.again')}
                  </Button>
                  <Button onClick={() => answer(true)}>
                    <Check className="h-4 w-4" />
                    {t('vocab.gotIt')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-8 flex justify-center border-t border-ink-100 pt-6">
                <Button size="lg" onClick={() => setRevealed(true)}>
                  {t('vocab.reveal')}
                </Button>
              </div>
            )}
          </Card>
        </div>
      ) : (
        <Card className="es-enter p-10 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success-50 text-success-700">
            <Check className="h-6 w-6" />
          </span>
          <h2 className="mt-5 font-display text-lg font-bold text-ink-900">
            {t('vocab.doneTitle')}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-500">
            {t('vocab.doneBody', { count: sessionDone })}
          </p>
          {sessionDone > 0 && (
            <Button
              variant="secondary"
              className="mt-5"
              onClick={() => setReviewedThisSession([])}
            >
              <RotateCcw className="h-4 w-4" />
              {t('vocab.reviewAgain')}
            </Button>
          )}
        </Card>
      )}

      {stats.total > 0 && (
        <Card className="es-enter p-6">
          <h2 className="font-display text-base font-bold text-ink-900">{t('vocab.deckTitle')}</h2>
          <ul className="mt-4 divide-y divide-ink-100">
            {cards.map((card) => (
              <li key={card.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 font-medium text-ink-900">{card.term}</span>
                {card.suggestion && (
                  <span className="text-sm text-success-700">→ {card.suggestion}</span>
                )}
                <span className="flex items-center gap-1.5" title={t('vocab.box', { box: card.box, max: MAX_BOX })}>
                  {Array.from({ length: MAX_BOX }).map((_, index) => (
                    <span
                      key={index}
                      className={cx(
                        'h-1.5 w-4 rounded-full',
                        index < card.box ? 'bg-brand-500' : 'bg-ink-100',
                      )}
                    />
                  ))}
                </span>
                <span className="w-20 text-right font-mono text-xs tabular text-ink-400">
                  {card.dueDate.slice(5)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
};
