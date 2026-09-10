import React, { useEffect, useState } from 'react';
import { AlertCircle, BookOpen, Headphones, Loader2, Mic, PenTool, RefreshCw } from 'lucide-react';
import type { SkillType } from '../types';
import type { PublicMaterialSummary } from '../services/publicMaterialView';
import { fetchLearnerMaterials } from '../services/publishedTests';
import { Button, Card } from './ui';

interface LearnerMaterialCatalogProps {
  /** Opens the material with this exact id. */
  onOpen: (section: SkillType, id: string) => Promise<void> | void;
  /** The material currently open, so the catalog can mark it. */
  activeMaterialId?: string;
}

const SECTION_ICONS: Record<SkillType, React.ElementType> = {
  listening: Headphones,
  reading: BookOpen,
  writing: PenTool,
  speaking: Mic,
};

const SECTIONS: SkillType[] = ['listening', 'reading', 'writing', 'speaking'];

/**
 * Every published material, as the learner's way in.
 *
 * Until now a material could only reach a learner inside a bundle, so a
 * perfectly good published Reading passage was unreachable unless somebody
 * assembled a four-skill exam around it. This lists what is published and opens
 * it by its own id.
 *
 * The list comes from `/api/learner/materials/:section`, which returns
 * published rows only — a draft or an archived material is not omitted from the
 * rendering here, it is never sent.
 */
export const LearnerMaterialCatalog: React.FC<LearnerMaterialCatalogProps> = ({
  onOpen,
  activeMaterialId,
}) => {
  const [items, setItems] = useState<PublicMaterialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const lists = await Promise.all(SECTIONS.map((section) => fetchLearnerMaterials(section)));
      setItems(lists.flat());
    } catch {
      setError('The catalog could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Loaded once when the hub opens; the refresh button is the way to re-read.
  }, []);

  const open = async (item: PublicMaterialSummary) => {
    setOpening(item.id);
    setError(null);
    try {
      await onOpen(item.section as SkillType, item.id);
    } catch {
      setError(`“${item.title}” could not be opened.`);
    } finally {
      setOpening(null);
    }
  };

  if (loading) {
    return (
      <Card className="es-enter flex items-center gap-3 p-5 text-sm text-ink-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the published catalog…
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card className="es-enter p-5" id="learner-catalog-empty">
        <p className="text-sm font-bold text-ink-900">No published practice materials yet</p>
        <p className="mt-1 text-xs text-ink-500">
          Materials appear here once an administrator publishes them.
        </p>
      </Card>
    );
  }

  return (
    <Card className="es-enter space-y-4 p-5" id="learner-material-catalog">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-ink-900">Published practice materials</p>
          <p className="mt-0.5 text-xs text-ink-500">
            {items.length} material{items.length === 1 ? '' : 's'} available. Opening one loads that
            material only.
          </p>
        </div>
        <button
          type="button"
          id="btn-refresh-learner-catalog"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-semibold text-ink-600 hover:border-ink-300"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {error && (
        <p
          id="learner-catalog-error"
          className="flex items-start gap-2 rounded-lg border border-danger-500/30 bg-danger-50 p-3 text-xs text-danger-700"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      <ul className="divide-y divide-ink-100">
        {items.map((item) => {
          const Icon = SECTION_ICONS[item.section as SkillType] ?? BookOpen;
          const isActive = item.id === activeMaterialId;
          return (
            <li
              key={item.id}
              data-material-id={item.id}
              data-section={item.section}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
                <div>
                  <p className="text-sm font-semibold text-ink-900">{item.title}</p>
                  <p className="mt-0.5 text-[11px] text-ink-500">
                    <span className="capitalize">{item.section}</span>
                    {item.part ? ` ${item.part}` : ''}
                    {' • '}
                    <span className="capitalize">{item.module}</span>
                    {item.theme ? ` • ${item.theme}` : ''}
                    {item.targetBand ? ` • Band ${item.targetBand}` : ''}
                    {' • '}
                    {item.questionCount} question{item.questionCount === 1 ? '' : 's'}
                  </p>
                </div>
              </div>

              <Button
                id={`btn-open-material-${item.id}`}
                variant={isActive ? 'primary' : 'secondary'}
                size="sm"
                disabled={opening === item.id}
                onClick={() => void open(item)}
              >
                {opening === item.id ? 'Opening…' : isActive ? 'Open again' : 'Open'}
              </Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
};
