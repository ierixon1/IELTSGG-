import React, { useState } from 'react';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  Edit,
  Eye,
  FileCode,
  Globe,
  Headphones,
  Loader2,
  Mic,
  PenTool,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { AdminMaterial, MaterialLifecycleStatus } from '../../types/admin';
import type { PublishBlocker } from '../../services/publishGate';

type SectionKey = 'speaking' | 'reading' | 'listening' | 'writing';
type StatusFilter = 'all' | MaterialLifecycleStatus;

interface AdminMaterialCatalogProps {
  materials: AdminMaterial[];
  searchQuery: string;
  onEdit: (material: AdminMaterial) => void;
  onPreview: (material: AdminMaterial) => void;
  onDelete: (material: AdminMaterial) => void;
  /** Re-reads the catalog after a lifecycle change. */
  onChanged: () => void;
  onToast: (message: string) => void;
}

const SECTION_ICONS: Record<SectionKey, React.ElementType> = {
  speaking: Mic,
  reading: BookOpen,
  listening: Headphones,
  writing: PenTool,
};

const STATUS_STYLES: Record<MaterialLifecycleStatus, string> = {
  draft: 'bg-ink-100 text-ink-600',
  published: 'bg-success-50 text-success-700',
  archived: 'bg-warning-50 text-warning-700',
};

const SECTIONS: Array<'all' | SectionKey> = ['all', 'speaking', 'reading', 'listening', 'writing'];
const STATUSES: StatusFilter[] = ['all', 'draft', 'published', 'archived'];

/** The passage or section number a material is printed with, if it has one. */
function partOf(material: AdminMaterial): number | null {
  const content = material.content as Record<string, any>;
  const raw =
    material.section === 'reading'
      ? content?.passage?.passageNumber
      : material.section === 'listening'
        ? content?.section?.sectionNumber
        : null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function questionCount(material: AdminMaterial): number {
  const content = material.content as Record<string, any>;
  const list = content?.passage?.questions ?? content?.section?.questions;
  return Array.isArray(list) ? list.length : 0;
}

/**
 * The admin's view of everything that exists, and what state it is in.
 *
 * The screen this replaces was a list, not a catalog: it filtered by section
 * and searched by title, and that was all it could do. There was no way to see
 * what was published, no way to publish anything (status was a dropdown inside
 * each editor, defaulting to published), and no sign of the `needsReview`
 * entries the API had been returning all along.
 *
 * Publishing is the decision this screen exists to support, so the reasons a
 * material cannot be published are shown here, against the material, rather
 * than raised as an error after the attempt.
 */
export const AdminMaterialCatalog: React.FC<AdminMaterialCatalogProps> = ({
  materials,
  searchQuery,
  onEdit,
  onPreview,
  onDelete,
  onChanged,
  onToast,
}) => {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sectionFilter, setSectionFilter] = useState<'all' | SectionKey>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<Record<string, PublishBlocker[]>>({});

  const visible = materials.filter((material) => {
    const matchesSection = sectionFilter === 'all' || material.section === sectionFilter;
    const matchesStatus = statusFilter === 'all' || material.status === statusFilter;
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !query ||
      material.title.toLowerCase().includes(query) ||
      (material.theme || '').toLowerCase().includes(query);
    return matchesSection && matchesStatus && matchesSearch;
  });

  const countFor = (status: StatusFilter) =>
    status === 'all' ? materials.length : materials.filter((m) => m.status === status).length;

  const act = async (material: AdminMaterial, action: 'publish' | 'unpublish' | 'archive' | 'restore') => {
    setBusyId(material.id);
    try {
      const response = await fetch(
        `/api/admin/materials/${material.section}/${encodeURIComponent(material.id)}/${action}`,
        { method: 'POST', credentials: 'same-origin' },
      );
      const body = await response.json();

      if (response.status === 409 && Array.isArray(body.blockers)) {
        // Not an error to dismiss: this is the list of things to fix, and it
        // stays on screen next to the material it concerns.
        setBlockers((previous) => ({ ...previous, [material.id]: body.blockers }));
        onToast(`"${material.title}" is not ready to publish.`);
        return;
      }
      if (!response.ok) throw new Error(body.error || 'The status could not be changed.');

      setBlockers((previous) => {
        const next = { ...previous };
        delete next[material.id];
        return next;
      });
      onToast(`"${material.title}" is now ${body.item.status}.`);
      onChanged();
    } catch (error: unknown) {
      onToast(error instanceof Error ? error.message : 'The status could not be changed.');
    } finally {
      setBusyId(null);
    }
  };

  const check = async (material: AdminMaterial) => {
    setBusyId(material.id);
    try {
      const response = await fetch(
        `/api/admin/materials/${material.section}/${encodeURIComponent(material.id)}/publish-check`,
        { credentials: 'same-origin' },
      );
      const body = await response.json();
      setBlockers((previous) => ({ ...previous, [material.id]: body.blockers || [] }));
      if (body.publishable) onToast(`"${material.title}" is ready to publish.`);
    } catch {
      onToast('The publish check could not be run.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4" id="admin-material-catalog">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5" id="catalog-status-filters">
          {STATUSES.map((status) => (
            <button
              key={status}
              id={`filter-status-${status}`}
              onClick={() => setStatusFilter(status)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                statusFilter === status
                  ? 'bg-ink-900 text-white'
                  : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
              }`}
            >
              {status} ({countFor(status)})
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto" id="catalog-section-filters">
          {SECTIONS.map((section) => (
            <button
              key={section}
              id={`filter-section-${section}`}
              onClick={() => setSectionFilter(section)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                sectionFilter === section
                  ? 'bg-brand-600 text-white'
                  : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
              }`}
            >
              {section} (
              {section === 'all'
                ? materials.length
                : materials.filter((m) => m.section === section).length}
              )
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-2xs">
        {visible.length === 0 ? (
          <div className="p-8 text-center text-xs text-ink-500" id="catalog-empty">
            Nothing here yet. Import a page or use the quick buttons above to author new material.
          </div>
        ) : (
          <div className="divide-y divide-ink-100">
            {visible.map((material) => {
              const Icon = SECTION_ICONS[material.section as SectionKey] ?? BookOpen;
              const part = partOf(material);
              const needsReview = material.needsReview ?? [];
              const imported = Boolean((material.content as Record<string, any>)?.importRecord);
              const rowBlockers = blockers[material.id];
              const busy = busyId === material.id;

              return (
                <div
                  key={material.id}
                  data-material-id={material.id}
                  data-status={material.status}
                  data-section={material.section}
                  className="p-4 transition-colors hover:bg-ink-50/70"
                >
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                    <div className="flex items-start space-x-3">
                      <Icon className="mt-1 h-4 w-4 shrink-0 text-ink-400" />
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-ink-900">{material.title}</span>
                          <span
                            data-status-badge={material.status}
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${STATUS_STYLES[material.status] ?? STATUS_STYLES.draft}`}
                          >
                            {material.status}
                          </span>
                          {imported && (
                            <span
                              data-imported="true"
                              title="Imported — its provenance is stored with it"
                              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700"
                            >
                              <FileCode className="h-2.5 w-2.5" />
                              Imported
                            </span>
                          )}
                          {needsReview.length > 0 && (
                            <span
                              data-needs-review={needsReview.length}
                              className="inline-flex items-center gap-1 rounded-full bg-danger-50 px-2 py-0.5 text-[10px] font-bold text-danger-700"
                            >
                              <AlertTriangle className="h-2.5 w-2.5" />
                              {needsReview.length} need review
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-500">
                          <span className="font-medium capitalize">{material.section}</span>
                          <span>•</span>
                          <span className="capitalize">{material.module || 'academic'}</span>
                          <span>•</span>
                          <span>{part ? `Part ${part}` : 'no part number'}</span>
                          <span>•</span>
                          <span>{material.theme || 'no theme'}</span>
                          <span>•</span>
                          <span>{material.targetBand ? `Band ${material.targetBand}` : 'no band'}</span>
                          <span>•</span>
                          <span>{questionCount(material)} questions</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1 self-end sm:self-start">
                      <button
                        onClick={() => onPreview(material)}
                        className="flex items-center gap-1 rounded-lg p-1.5 text-xs text-ink-500 hover:bg-brand-50 hover:text-brand-600"
                        title="Candidate preview"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Preview</span>
                      </button>

                      <button
                        onClick={() => onEdit(material)}
                        className="flex items-center gap-1 rounded-lg p-1.5 text-xs text-ink-500 hover:bg-ink-100 hover:text-ink-900"
                        title="Edit material"
                      >
                        <Edit className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Edit</span>
                      </button>

                      {material.status !== 'published' && (
                        <>
                          <button
                            id={`btn-check-${material.id}`}
                            onClick={() => void check(material)}
                            disabled={busy}
                            className="flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1.5 text-xs font-semibold text-ink-600 hover:border-ink-300 disabled:opacity-50"
                            title="What would stop this being published?"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Check
                          </button>
                          <button
                            id={`btn-publish-${material.id}`}
                            onClick={() => void act(material, 'publish')}
                            disabled={busy}
                            className="flex items-center gap-1 rounded-lg bg-success-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-success-700 disabled:opacity-50"
                          >
                            {busy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Globe className="h-3.5 w-3.5" />
                            )}
                            Publish
                          </button>
                        </>
                      )}

                      {material.status === 'published' && (
                        <button
                          id={`btn-unpublish-${material.id}`}
                          onClick={() => void act(material, 'unpublish')}
                          disabled={busy}
                          className="flex items-center gap-1 rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                          Unpublish
                        </button>
                      )}

                      {material.status === 'archived' ? (
                        <button
                          id={`btn-restore-${material.id}`}
                          onClick={() => void act(material, 'restore')}
                          disabled={busy}
                          className="flex items-center gap-1 rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Restore
                        </button>
                      ) : (
                        <button
                          id={`btn-archive-${material.id}`}
                          onClick={() => void act(material, 'archive')}
                          disabled={busy}
                          className="flex items-center gap-1 rounded-lg p-1.5 text-xs text-ink-500 hover:bg-warning-50 hover:text-warning-700 disabled:opacity-50"
                          title="Retire without deleting"
                        >
                          <Archive className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Archive</span>
                        </button>
                      )}

                      <button
                        onClick={() => onDelete(material)}
                        className="rounded-lg p-1.5 text-ink-400 hover:bg-danger-50 hover:text-danger-500"
                        title="Delete permanently"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {rowBlockers && rowBlockers.length > 0 && (
                    <div
                      data-blockers-for={material.id}
                      className="mt-3 rounded-lg border border-danger-500/30 bg-danger-50 p-3"
                    >
                      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-danger-700">
                        Cannot publish yet
                      </p>
                      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-danger-700">
                        {rowBlockers.map((blocker, index) => (
                          <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {rowBlockers && rowBlockers.length === 0 && (
                    <p
                      data-blockers-for={material.id}
                      className="mt-3 rounded-lg border border-success-500/30 bg-success-50 p-2.5 text-xs font-semibold text-success-700"
                    >
                      Ready to publish.
                    </p>
                  )}

                  {needsReview.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-8 text-[11px] text-danger-600">
                      {needsReview.slice(0, 5).map((reason, index) => (
                        <li key={index}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
