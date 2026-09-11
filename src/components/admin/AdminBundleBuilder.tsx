import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Globe, Layers, Loader2, Pin, Save, ShieldCheck, X } from 'lucide-react';
import {
  BUNDLE_SECTIONS,
  IELTS_REFERENCE_MINUTES,
  REQUIRED_PARTS,
  minutesKey,
  type BundleBlocker,
  type BundleSection,
  type BundleSummary,
  type BundleTiming,
  type FullCdiBundle,
} from '../../types/bundle';
import type { BundleCandidate, ComponentDetail } from '../../services/bundleService';

interface BundleDetail {
  bundle: FullCdiBundle;
  summary: BundleSummary;
  components: ComponentDetail[];
  blockers: BundleBlocker[];
}

interface AdminBundleBuilderProps {
  /** The bundle to open, or null to assemble a new one. */
  bundleId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onToast: (message: string) => void;
}

interface Slot {
  key: string;
  section: BundleSection;
  part: number;
  label: string;
}

const SLOTS: Slot[] = BUNDLE_SECTIONS.flatMap((section) =>
  REQUIRED_PARTS[section].map((part) => ({
    key: `${section}-${part}`,
    section,
    part,
    label:
      section === 'listening'
        ? `Listening Part ${part}`
        : section === 'reading'
          ? `Reading Passage ${part}`
          : section === 'writing'
            ? 'Writing — Task 1 and Task 2'
            : 'Speaking — Parts 1, 2 and 3',
  })),
);

type Pin = { materialId: string; contentHash: string };
type MinutesField = '' | number;

const SECTION_NAME: Record<BundleSection, string> = { listening: 'Listening', reading: 'Reading', writing: 'Writing', speaking: 'Speaking' };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

const shortHash = (hash: string) => (hash ? hash.slice(0, 12) : 'unpinned');

/**
 * Assembles a Full CDI bundle from published materials.
 *
 * Every slot pins one published material and the exact version of its content
 * at the moment it is chosen; the builder shows that version next to the
 * material, so what is pinned is never confused with what the material says now.
 * Draft and archived materials are not offered. A pinned material that has since
 * changed, been withdrawn or lost its audio says so in its slot, and pinning the
 * new version is a deliberate click.
 *
 * Saving stores a draft and never publishes. Publishing is a separate action,
 * available only when the saved bundle has just passed its check.
 */
export const AdminBundleBuilder: React.FC<AdminBundleBuilderProps> = ({ bundleId, onClose, onChanged, onToast }) => {
  const [candidates, setCandidates] = useState<BundleCandidate[]>([]);
  const [detail, setDetail] = useState<BundleDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState('');
  const [module, setModule] = useState<'academic' | 'general'>('academic');
  const [targetBand, setTargetBand] = useState('');
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState<Record<BundleSection, MinutesField>>({ listening: '', reading: '', writing: '', speaking: '' });
  const [basis, setBasis] = useState<BundleTiming['basis']>('custom');
  const [allowEarlyFinish, setAllowEarlyFinish] = useState(true);
  const [pins, setPins] = useState<Record<string, Pin | undefined>>({});

  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'check' | 'publish'>(null);
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const [check, setCheck] = useState<{ updatedAt: string; blockers: BundleBlocker[] } | null>(null);

  const applyDetail = (next: BundleDetail) => {
    setDetail(next);
    const { bundle } = next;
    setTitle(bundle.title);
    setModule(bundle.module);
    setTargetBand(bundle.targetBand ?? '');
    setDescription(bundle.description ?? '');
    setMinutes(Object.fromEntries(BUNDLE_SECTIONS.map((section) => [section, bundle.timing[minutesKey(section)] || ''])) as Record<BundleSection, MinutesField>);
    setBasis(bundle.timing.basis);
    setAllowEarlyFinish(bundle.timing.allowEarlyFinish);
    setPins(
      Object.fromEntries(
        bundle.components.map((ref) => [`${ref.section}-${ref.part}`, { materialId: ref.materialId, contentHash: ref.contentHash }]),
      ),
    );
    setDirty(false);
    setSaveIssues([]);
  };

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [candidateResponse, detailResponse] = await Promise.all([
          fetch('/api/admin/bundles/candidates', { credentials: 'same-origin' }),
          bundleId ? fetch(`/api/admin/bundles/${encodeURIComponent(bundleId)}`, { credentials: 'same-origin' }) : Promise.resolve(null),
        ]);
        const candidateBody = await readJson(candidateResponse);
        if (!candidateResponse.ok) throw new Error(String(candidateBody.error ?? 'Published materials could not be loaded.'));
        if (!active) return;
        setCandidates(Array.isArray(candidateBody.candidates) ? (candidateBody.candidates as BundleCandidate[]) : []);
        if (detailResponse) {
          const detailBody = await readJson(detailResponse);
          if (!detailResponse.ok) throw new Error(String(detailBody.error ?? 'The bundle could not be loaded.'));
          if (active) applyDetail(detailBody as unknown as BundleDetail);
        }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'The builder could not load.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [bundleId]);

  const status = detail?.bundle.status ?? 'draft';
  const editable = status === 'draft';
  const blockers = check && detail && check.updatedAt === detail.bundle.updatedAt ? check.blockers : detail?.blockers ?? [];
  const checkedCurrent = Boolean(check && detail && check.updatedAt === detail.bundle.updatedAt && !dirty);
  const canPublish = Boolean(detail && status === 'draft' && !dirty && checkedCurrent && check?.blockers.length === 0);

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setDirty(true);
  };

  const setMinutesFor = (section: BundleSection, raw: string) => {
    setMinutes((current) => ({ ...current, [section]: raw === '' ? '' : Number(raw) }));
    // A hand-typed value is custom timing, and is labelled so.
    setBasis('custom');
    setDirty(true);
  };

  const applyReferenceTiming = () => {
    setMinutes({
      listening: IELTS_REFERENCE_MINUTES.listeningMinutes,
      reading: IELTS_REFERENCE_MINUTES.readingMinutes,
      writing: IELTS_REFERENCE_MINUTES.writingMinutes,
      speaking: IELTS_REFERENCE_MINUTES.speakingMinutes,
    });
    setBasis('ielts_reference');
    setDirty(true);
  };

  const pinCandidate = (slot: Slot, candidate: BundleCandidate | undefined) => {
    setPins((current) => ({ ...current, [slot.key]: candidate ? { materialId: candidate.id, contentHash: candidate.contentHash } : undefined }));
    setDirty(true);
  };

  const save = async () => {
    setBusy('save');
    setSaveIssues([]);
    try {
      const payload = {
        title,
        module,
        ...(targetBand.trim() ? { targetBand: targetBand.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        components: SLOTS.flatMap((slot) => {
          const pin = pins[slot.key];
          return pin ? [{ section: slot.section, part: slot.part, materialId: pin.materialId, contentHash: pin.contentHash }] : [];
        }),
        timing: {
          listeningMinutes: Number(minutes.listening),
          readingMinutes: Number(minutes.reading),
          writingMinutes: Number(minutes.writing),
          speakingMinutes: Number(minutes.speaking),
          basis,
          allowEarlyFinish,
        },
      };
      const response = await fetch(detail ? `/api/admin/bundles/${encodeURIComponent(detail.bundle.id)}` : '/api/admin/bundles', {
        method: detail ? 'PUT' : 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setSaveIssues(Array.isArray(body.issues) ? (body.issues as string[]) : [String(body.error ?? 'The draft could not be saved.')]);
        return;
      }
      applyDetail(body as unknown as BundleDetail);
      setCheck(null);
      onChanged();
      onToast('Bundle saved as a draft. It is not published.');
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async () => {
    if (!detail) return;
    setBusy('check');
    try {
      const response = await fetch(`/api/admin/bundles/${encodeURIComponent(detail.bundle.id)}/check`, { credentials: 'same-origin' });
      const body = await readJson(response);
      if (!response.ok) {
        onToast(String(body.error ?? 'The check failed.'));
        return;
      }
      setCheck({ updatedAt: detail.bundle.updatedAt, blockers: (body.blockers as BundleBlocker[]) ?? [] });
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!detail) return;
    setBusy('publish');
    try {
      const response = await fetch(`/api/admin/bundles/${encodeURIComponent(detail.bundle.id)}/publish`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const body = await readJson(response);
      if (response.status === 409 && Array.isArray(body.blockers)) {
        setCheck({ updatedAt: detail.bundle.updatedAt, blockers: body.blockers as BundleBlocker[] });
        onToast('The bundle is not ready to be published.');
        return;
      }
      if (!response.ok) {
        onToast(String(body.error ?? 'The bundle could not be published.'));
        return;
      }
      applyDetail(body as unknown as BundleDetail);
      setCheck(null);
      onChanged();
      onToast('Bundle published. Learners can now sit it.');
    } finally {
      setBusy(null);
    }
  };

  const bundleLevelBlockers = useMemo(() => blockers.filter((blocker) => blocker.part === undefined || !blocker.section), [blockers]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-xs text-ink-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading published materials…
      </div>
    );
  }

  if (loadError) {
    return (
      <div id="bundle-builder-error" className="rounded-xl border border-danger-500/30 bg-danger-50 p-4 text-xs text-danger-700">
        {loadError}
        <button type="button" onClick={onClose} className="ml-3 font-semibold underline">
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5" id="bundle-builder" data-bundle-id={detail?.bundle.id ?? ''} data-status={status} data-dirty={String(dirty)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 pb-4">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-ink-900">
            <Layers className="h-4 w-4 text-brand-600" />
            {detail ? 'Full CDI bundle' : 'Assemble a Full CDI bundle'}
          </h3>
          <p className="text-xs text-ink-500">
            Listening Parts 1–4, Reading Passages 1–3, one Writing material with both tasks and one Speaking material with all three parts — each
            pinned to the exact published version shown.
          </p>
          {detail && (
            <p className="mt-1 font-mono text-[10px] text-ink-400">
              {detail.bundle.id} · updated {detail.bundle.updatedAt}
              {detail.bundle.publishedAt ? ` · last published ${detail.bundle.publishedAt}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            id="bundle-status"
            className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${
              status === 'published' ? 'bg-success-50 text-success-700' : status === 'archived' ? 'bg-warning-50 text-warning-700' : 'bg-ink-100 text-ink-600'
            }`}
          >
            {status}
          </span>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100" title="Close the builder">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!editable && (
        <p id="bundle-read-only" className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-700">
          {status === 'published'
            ? 'This bundle is published and read-only, so what learners sit stays reproducible. Unpublish it from the catalog to change it.'
            : 'This bundle is archived and read-only. Restore it from the catalog to change it.'}
        </p>
      )}

      <fieldset disabled={!editable} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="sm:col-span-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Title</span>
            <input id="bundle-title" value={title} onChange={(event) => change(setTitle)(event.target.value)} className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-xs" />
          </label>
          <label>
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Module</span>
            <select id="bundle-module" value={module} onChange={(event) => change(setModule)(event.target.value as 'academic' | 'general')} className="mt-1 w-full rounded-lg border border-ink-200 px-2 py-2 text-xs">
              <option value="academic">Academic</option>
              <option value="general">General Training</option>
            </select>
          </label>
          <label>
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Target band (optional)</span>
            <input id="bundle-band" value={targetBand} onChange={(event) => change(setTargetBand)(event.target.value)} className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-xs" />
          </label>
          <label className="sm:col-span-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">Description for learners (optional)</span>
            <input id="bundle-description" value={description} onChange={(event) => change(setDescription)(event.target.value)} className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-xs" />
          </label>
        </div>

        <div className="space-y-2 rounded-xl border border-ink-200 bg-ink-50 p-4" id="bundle-timing" data-basis={basis}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold text-ink-800">
              <Clock className="h-3.5 w-3.5" /> Section timing
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${basis === 'ielts_reference' ? 'bg-brand-50 text-brand-700' : 'bg-white text-ink-600'}`}>
                {basis === 'ielts_reference' ? 'IELTS reference' : 'custom'}
              </span>
            </span>
            <button id="btn-bundle-reference-timing" type="button" onClick={applyReferenceTiming} className="rounded-lg border border-ink-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-ink-700">
              Use IELTS reference timing (30 / 60 / 60 / 14 min)
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            {BUNDLE_SECTIONS.map((section) => (
              <label key={section}>
                <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-500">{SECTION_NAME[section]} minutes</span>
                <input
                  id={`bundle-minutes-${section}`}
                  type="number"
                  min={1}
                  value={minutes[section]}
                  onChange={(event) => setMinutesFor(section, event.target.value)}
                  className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-xs"
                />
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-700">
            <input id="bundle-allow-early-finish" type="checkbox" checked={allowEarlyFinish} onChange={(event) => change(setAllowEarlyFinish)(event.target.checked)} />
            Learners may finish a section early once its content is complete
          </label>
        </div>

        <div className="space-y-2">
          {SLOTS.map((slot) => {
            const pin = pins[slot.key];
            const offered = candidates.filter(
              (candidate) => candidate.section === slot.section && (slot.section === 'writing' || slot.section === 'speaking' || candidate.part === slot.part),
            );
            const published = pin ? candidates.find((candidate) => candidate.id === pin.materialId) : undefined;
            const stored = pin
              ? detail?.components.find((entry) => entry.ref.section === slot.section && entry.ref.part === slot.part && entry.ref.materialId === pin.materialId)?.material ?? null
              : null;
            const shown = published ?? stored;
            const slotBlockers = blockers.filter((blocker) => blocker.section === slot.section && blocker.part === slot.part);
            const state = !pin
              ? 'empty'
              : !shown
                ? 'not_found'
                : shown.status !== 'published'
                  ? 'not_published'
                  : !published || published.contentHash !== pin.contentHash
                    ? 'changed'
                    : 'pinned';

            return (
              <div key={slot.key} data-slot={slot.key} data-slot-state={state} className="rounded-xl border border-ink-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-ink-900">{slot.label}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                      state === 'pinned' ? 'bg-success-50 text-success-700' : state === 'empty' ? 'bg-ink-100 text-ink-500' : 'bg-danger-50 text-danger-700'
                    }`}
                  >
                    {state === 'pinned' ? 'pinned · published' : state.replace('_', ' ')}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    id={`bundle-slot-${slot.key}`}
                    value={pin?.materialId ?? ''}
                    onChange={(event) => pinCandidate(slot, offered.find((candidate) => candidate.id === event.target.value))}
                    className="min-w-0 flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-xs"
                  >
                    <option value="">— choose a published material —</option>
                    {pin && !published && (
                      <option value={pin.materialId} disabled>
                        Pinned: {stored?.title ?? pin.materialId} ({stored ? stored.status : 'not found'})
                      </option>
                    )}
                    {offered.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title} · {candidate.id} · {candidate.module === 'general' ? 'GT' : 'AC'}
                        {candidate.targetBand ? ` · band ${candidate.targetBand}` : ''}
                      </option>
                    ))}
                  </select>
                  {published && pin && published.contentHash !== pin.contentHash && (
                    <button
                      id={`btn-bundle-repin-${slot.key}`}
                      type="button"
                      onClick={() => pinCandidate(slot, published)}
                      className="inline-flex items-center gap-1 rounded-lg border border-warning-500/40 bg-warning-50 px-2 py-1 text-[11px] font-semibold text-warning-800"
                    >
                      <Pin className="h-3 w-3" /> Pin the current published version
                    </button>
                  )}
                </div>

                {shown && pin && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[10px] text-ink-600" data-slot-detail={slot.key}>
                    <dt>material</dt>
                    <dd>
                      {shown.title} ({shown.id})
                    </dd>
                    <dt>pinned version</dt>
                    <dd data-pinned-hash={pin.contentHash}>
                      {shortHash(pin.contentHash)}
                      {published && published.contentHash !== pin.contentHash ? ` — published content is now ${shortHash(published.contentHash)}` : ''}
                    </dd>
                    <dt>status</dt>
                    <dd>{shown.status}</dd>
                    <dt>metadata</dt>
                    <dd>
                      {shown.module === 'general' ? 'General Training' : 'Academic'} · {shown.part ? `part ${shown.part}` : 'whole paper'} · band{' '}
                      {shown.targetBand ?? '—'} · updated {shown.updatedAt}
                    </dd>
                    <dt>content</dt>
                    <dd>
                      {slot.section === 'listening' || slot.section === 'reading'
                        ? `${shown.questionCount} questions`
                        : slot.section === 'writing'
                          ? `${shown.taskCount} of 2 tasks`
                          : `${shown.taskCount} of 3 parts`}
                    </dd>
                    {shown.audio && (
                      <>
                        <dt>audio</dt>
                        <dd data-audio-exists={String(shown.audio.exists)}>
                          {shown.audio.assetId ? `${shown.audio.assetId} (${shown.audio.exists ? shown.audio.kind ?? 'unknown kind' : 'missing'})` : 'no audio file'}
                        </dd>
                      </>
                    )}
                    <dt>assets</dt>
                    <dd>{shown.assetCount}</dd>
                  </dl>
                )}

                {slotBlockers.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-[11px] text-danger-700">
                    {slotBlockers.map((blocker, index) => (
                      <li key={`${blocker.code}-${index}`} data-blocker-code={blocker.code}>
                        <span className="font-mono text-[10px]">{blocker.code}</span> {blocker.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      {saveIssues.length > 0 && (
        <ul id="bundle-save-issues" className="space-y-0.5 rounded-lg border border-danger-500/30 bg-danger-50 p-3 text-[11px] text-danger-700">
          {saveIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      {detail && (checkedCurrent || bundleLevelBlockers.length > 0) && (
        <div id="bundle-check-result" data-publishable={String(checkedCurrent && blockers.length === 0)} className={`rounded-lg border p-3 text-xs ${blockers.length === 0 ? 'border-success-500/30 bg-success-50 text-success-700' : 'border-danger-500/30 bg-danger-50 text-danger-700'}`}>
          {blockers.length === 0 ? (
            <p className="flex items-center gap-1.5 font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5" /> Ready to publish.
            </p>
          ) : (
            <>
              <p className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="h-3.5 w-3.5" /> {blockers.length} reason{blockers.length === 1 ? '' : 's'} this bundle cannot be published
              </p>
              <ul className="mt-1 space-y-0.5">
                {bundleLevelBlockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`} data-blocker-code={blocker.code}>
                    <span className="font-mono text-[10px]">{blocker.code}</span> {blocker.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-200 pt-4">
        {dirty && <span className="text-[11px] text-warning-800">Unsaved changes — save the draft before checking or publishing.</span>}
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-xs font-semibold text-ink-600 hover:text-ink-900">
          Close
        </button>
        <button
          id="btn-bundle-save"
          type="button"
          disabled={!editable || busy !== null}
          onClick={() => void save()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
        >
          {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save draft
        </button>
        <button
          id="btn-bundle-check"
          type="button"
          disabled={!detail || dirty || busy !== null}
          onClick={() => void runCheck()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-300 px-4 py-2 text-xs font-bold text-ink-700 disabled:opacity-50"
        >
          {busy === 'check' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Check
        </button>
        <button
          id="btn-bundle-publish"
          type="button"
          disabled={!canPublish || busy !== null}
          onClick={() => void publish()}
          title={canPublish ? 'Publish this bundle' : 'Save the draft and run a passing check first'}
          className="inline-flex items-center gap-1.5 rounded-lg bg-success-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
        >
          {busy === 'publish' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
          Publish
        </button>
      </div>
    </div>
  );
};
