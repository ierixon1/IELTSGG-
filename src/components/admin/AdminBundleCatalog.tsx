import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Archive, CheckCircle2, Edit, Globe, Loader2, RotateCcw, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import type { BundleBlocker, BundleComponentRef, BundleLifecycleStatus, BundleSummary } from '../../types/bundle';

interface CatalogBundle extends BundleSummary {
  components: BundleComponentRef[];
  firstPublishedAt?: string;
}

interface AdminBundleCatalogProps {
  /** Opens the builder on a bundle, or on a new one. */
  onEdit: (bundleId: string | null) => void;
  onChanged: () => void;
  onToast: (message: string) => void;
}

const FILTERS: Array<BundleLifecycleStatus | 'all'> = ['all', 'draft', 'published', 'archived'];

const STATUS_STYLE: Record<BundleLifecycleStatus, string> = {
  draft: 'bg-ink-100 text-ink-600',
  published: 'bg-success-50 text-success-700',
  archived: 'bg-warning-50 text-warning-700',
};

/**
 * Every Full CDI bundle and where it is in its life.
 *
 * Draft bundles can be edited, checked, published, archived and — if they were
 * never published — deleted. A published bundle is read-only: it can be checked,
 * withdrawn or retired. A retired bundle can be restored. A bundle that was ever
 * published is never deleted, because attempts refer to it.
 */
export const AdminBundleCatalog: React.FC<AdminBundleCatalogProps> = ({ onEdit, onChanged, onToast }) => {
  const [filter, setFilter] = useState<BundleLifecycleStatus | 'all'>('all');
  const [bundles, setBundles] = useState<CatalogBundle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<Record<string, BundleBlocker[]>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/admin/bundles?status=${filter}`, { credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'The bundle catalog could not be loaded.');
      setBundles(Array.isArray(body.bundles) ? (body.bundles as CatalogBundle[]) : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The bundle catalog could not be loaded.');
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (bundle: CatalogBundle, action: 'check' | 'publish' | 'unpublish' | 'archive' | 'restore' | 'delete') => {
    if (action === 'delete' && !window.confirm(`Delete the draft bundle "${bundle.title}"?`)) return;
    setBusyId(bundle.id);
    try {
      const url =
        action === 'check'
          ? `/api/admin/bundles/${encodeURIComponent(bundle.id)}/check`
          : action === 'delete'
            ? `/api/admin/bundles/${encodeURIComponent(bundle.id)}`
            : `/api/admin/bundles/${encodeURIComponent(bundle.id)}/${action}`;
      const response = await fetch(url, {
        method: action === 'check' ? 'GET' : action === 'delete' ? 'DELETE' : 'POST',
        credentials: 'same-origin',
      });
      const body = await response.json().catch(() => ({}));

      if (action === 'check' && response.ok) {
        setBlockers((current) => ({ ...current, [bundle.id]: body.blockers ?? [] }));
        return;
      }
      if (action === 'publish' && response.status === 409 && Array.isArray(body.blockers)) {
        setBlockers((current) => ({ ...current, [bundle.id]: body.blockers }));
        onToast(`"${bundle.title}" is not ready to be published.`);
        return;
      }
      if (!response.ok) {
        onToast(body.error || `Could not ${action} the bundle.`);
        return;
      }
      setBlockers((current) => {
        const { [bundle.id]: _cleared, ...rest } = current;
        return rest;
      });
      onToast(
        action === 'publish'
          ? `"${bundle.title}" is published.`
          : action === 'delete'
            ? `"${bundle.title}" was deleted.`
            : `"${bundle.title}" is now ${action === 'unpublish' || action === 'restore' ? 'a draft' : 'archived'}.`,
      );
      await load();
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const button = (id: string, label: string, icon: React.ReactNode, onClick: () => void, tone = 'text-ink-600 hover:bg-ink-100', title?: string, disabled = false) => (
    <button
      id={id}
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold disabled:opacity-40 ${tone}`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="space-y-4" id="bundle-catalog">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-xl bg-ink-100 p-1">
          {FILTERS.map((value) => (
            <button
              key={value}
              id={`bundle-filter-${value}`}
              type="button"
              onClick={() => setFilter(value)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize ${filter === value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-600'}`}
            >
              {value}
            </button>
          ))}
        </div>
        <button id="btn-new-bundle" type="button" onClick={() => onEdit(null)} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white">
          + New bundle
        </button>
      </div>

      {error && <p className="rounded-lg border border-danger-500/30 bg-danger-50 p-3 text-xs text-danger-700">{error}</p>}
      {!error && bundles === null && (
        <p className="flex items-center gap-2 text-xs text-ink-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading bundles…
        </p>
      )}
      {bundles?.length === 0 && <p className="text-xs text-ink-500">No bundles{filter === 'all' ? '' : ` with status ${filter}`}.</p>}

      <div className="divide-y divide-ink-100 overflow-hidden rounded-2xl border border-ink-200 bg-white">
        {bundles?.map((bundle) => {
          const busy = busyId === bundle.id;
          const rowBlockers = blockers[bundle.id];
          return (
            <div key={bundle.id} className="space-y-2 p-4" data-bundle-id={bundle.id} data-status={bundle.status}>
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-ink-900">{bundle.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLE[bundle.status]}`}>{bundle.status}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-ink-400">{bundle.id}</p>
                  <p className="mt-1 text-[11px] text-ink-600">
                    {bundle.module === 'general' ? 'General Training' : 'Academic'} · Listening {bundle.parts.listening}/4 · Reading {bundle.parts.reading}/3 · Writing{' '}
                    {bundle.parts.writing}/1 · Speaking {bundle.parts.speaking}/1 · {bundle.totalMinutes} min ({bundle.timing.basis === 'ielts_reference' ? 'IELTS reference timing' : 'custom timing'})
                  </p>
                  {bundle.publishedAt && <p className="text-[10px] text-ink-400">last published {bundle.publishedAt}</p>}
                </div>

                <div className="flex flex-wrap items-center gap-1 self-end sm:self-start">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-400" />}
                  {button(`btn-bundle-edit-${bundle.id}`, bundle.status === 'draft' ? 'Edit' : 'View', <Edit className="h-3.5 w-3.5" />, () => onEdit(bundle.id))}
                  {button(`btn-bundle-check-${bundle.id}`, 'Check', <ShieldCheck className="h-3.5 w-3.5" />, () => void act(bundle, 'check'))}
                  {bundle.status === 'draft' &&
                    button(`btn-bundle-publish-${bundle.id}`, 'Publish', <Globe className="h-3.5 w-3.5" />, () => void act(bundle, 'publish'), 'bg-success-600 text-white hover:bg-success-700')}
                  {bundle.status === 'published' &&
                    button(`btn-bundle-unpublish-${bundle.id}`, 'Unpublish', <Undo2 className="h-3.5 w-3.5" />, () => void act(bundle, 'unpublish'))}
                  {bundle.status !== 'archived' &&
                    button(`btn-bundle-archive-${bundle.id}`, 'Archive', <Archive className="h-3.5 w-3.5" />, () => void act(bundle, 'archive'))}
                  {bundle.status === 'archived' &&
                    button(`btn-bundle-restore-${bundle.id}`, 'Restore', <RotateCcw className="h-3.5 w-3.5" />, () => void act(bundle, 'restore'))}
                  {bundle.status !== 'published' &&
                    button(
                      `btn-bundle-delete-${bundle.id}`,
                      'Delete',
                      <Trash2 className="h-3.5 w-3.5" />,
                      () => void act(bundle, 'delete'),
                      'text-danger-600 hover:bg-danger-50',
                      bundle.firstPublishedAt ? 'Once published, a bundle is archived rather than deleted.' : undefined,
                      Boolean(bundle.firstPublishedAt),
                    )}
                </div>
              </div>

              {rowBlockers && (
                <div
                  data-blockers-for={bundle.id}
                  className={`rounded-lg border p-2.5 text-xs ${rowBlockers.length === 0 ? 'border-success-500/30 bg-success-50 text-success-700' : 'border-danger-500/30 bg-danger-50 text-danger-700'}`}
                >
                  {rowBlockers.length === 0 ? (
                    <p className="flex items-center gap-1.5 font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Ready to publish — every component is published, pinned and complete.
                    </p>
                  ) : (
                    <>
                      <p className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle className="h-3.5 w-3.5" /> Cannot be published or sat:
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {rowBlockers.map((blocker, index) => (
                          <li key={`${blocker.code}-${index}`} data-blocker-code={blocker.code}>
                            <span className="font-mono text-[10px]">{blocker.code}</span> {blocker.message}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
