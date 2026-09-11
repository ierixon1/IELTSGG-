import React, { useState, useEffect } from 'react';
import { 
  ShieldCheck, 
  Layers, 
  BookOpen, 
  Headphones, 
  Edit3, 
  Mic, 
  Plus, 
  Trash2, 
  Edit, 
  Eye, 
  LogOut, 
  Sparkles, 
  FileText,
  FileCode,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle
} from 'lucide-react';
import { AdminUser, AdminMaterial, AdminStats } from '../../types/admin';
import type { BundleSummary } from '../../types/bundle';
import { AdminSpeakingEditor } from './AdminSpeakingEditor';
import { AdminReadingEditor } from './AdminReadingEditor';
import { AdminListeningEditor } from './AdminListeningEditor';
import { AdminWritingEditor } from './AdminWritingEditor';
import { AdminBundleBuilder } from './AdminBundleBuilder';
import { AdminBundleCatalog } from './AdminBundleCatalog';
import { AdminImportReview } from './AdminImportReview';
import { AdminImportStart } from './AdminImportStart';
import { buildReviewState } from '../../services/cdiImport/review';
import type { ReviewState } from '../../services/cdiImport/review';
import { AdminPreviewModal } from './AdminPreviewModal';
import { AdminMaterialCatalog } from './AdminMaterialCatalog';
import { AdminSourceLibrary } from './AdminSourceLibrary';
import { loadGeneratedReview } from './generatedReview';

interface AdminDashboardProps {
  adminUser: AdminUser;
  onLogout: () => void;
}

type TabKey = 'materials' | 'bundles' | 'sources' | 'analytics';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  adminUser,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('materials');
  const [searchQuery, setSearchQuery] = useState('');

  const [materials, setMaterials] = useState<AdminMaterial[]>([]);
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  // Editor states
  const [editorMode, setEditorMode] = useState<
    'none' | 'speaking' | 'reading' | 'listening' | 'writing' | 'bundle' | 'import'
  >('none');
  /**
   * An import in progress. It lives here rather than in the review screen so a
   * correction survives a re-render, and so nothing is written until the admin
   * saves — parsing a page is not publishing it.
   */
  const [importReview, setImportReview] = useState<ReviewState | null>(null);
  const [editingItem, setEditingItem] = useState<any | null>(null);
  /** The bundle open in the builder; null assembles a new one. */
  const [editingBundleId, setEditingBundleId] = useState<string | null>(null);

  // Preview state
  const [previewMaterial, setPreviewMaterial] = useState<AdminMaterial | null>(null);

  // Fetch initial data
  const fetchData = async () => {
    setLoading(true);
    try {
      const [matRes, bunRes, statRes] = await Promise.all([
        fetch('/api/admin/materials', { credentials: 'same-origin', headers: { } }),
        fetch('/api/admin/bundles', { credentials: 'same-origin', headers: { } }),
        fetch('/api/admin/stats', { credentials: 'same-origin', headers: { } }),
      ]);

      if (matRes.ok) {
        // GET /api/admin/materials answers `{ items: [...] }`. Reading the
        // wrong key here left the repository permanently empty, which also
        // emptied the bundle builder's four material dropdowns.
        const d = await matRes.json();
        setMaterials(Array.isArray(d.items) ? d.items : []);
      }
      if (bunRes.ok) {
        const d = await bunRes.json();
        setBundles(d.bundles || []);
      }
      if (statRes.ok) {
        const d = await statRes.json();
        setStats(d.stats || null);
      }
    } catch (err) {
      console.error('Error fetching admin data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const showToast = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  // CRUD for Material
  const handleSaveMaterial = async (item: Partial<AdminMaterial>) => {
    try {
      const method = item.id ? 'PUT' : 'POST';
      const url = item.id ? `/api/admin/materials/${item.id}` : '/api/admin/materials';

      const res = await fetch(url, {
        credentials: 'same-origin', method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(item),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save material.');

      showToast(`Successfully saved "${item.title || 'material'}"`);
      setEditorMode('none');
      setEditingItem(null);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  /**
   * Saves a reviewed import as a draft material.
   *
   * The write boundary from phase 4 validates it again on the way in, so a
   * review that let something through is still caught before it is stored.
   */
  const handleSaveImportedDraft = async (payload: { id?: string; section: string; title: string }) => {
    // A generated draft exists before review opens; saving it updates that
    // material instead of creating a second copy beside it.
    const url = payload.id
      ? `/api/admin/materials/${payload.section}/${encodeURIComponent(payload.id)}`
      : '/api/admin/materials';
    const res = await fetch(url, {
      credentials: 'same-origin',
      method: payload.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        data.issues?.length ? `${data.error} ${data.issues.join(' ')}` : data.error || 'Failed to save the draft.',
      );
    }
    showToast(`Saved "${payload.title}" as a draft.`);
    setImportReview(null);
    setEditorMode('none');
    fetchData();
  };

  /**
   * Records a reviewer's decision about a flagged generated question, then
   * refreshes only the decision log in the open review, so unsaved corrections
   * on the screen are left as they are.
   */
  const handleReviewGenerated = async (generatedQuestionId: string, decision: 'confirmed' | 'rejected', note: string) => {
    const materialId = importReview?.materialId;
    if (!materialId) throw new Error('Save the draft before recording a decision.');
    const base = `/api/admin/sources/generated/${encodeURIComponent(materialId)}`;
    const res = await fetch(`${base}/questions/${encodeURIComponent(generatedQuestionId)}/reviews`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, note }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.issues?.length ? `${data.error} ${data.issues.join(' ')}` : data.error || 'The decision could not be recorded.');
    }
    const refreshed = await fetch(`${base}/review`, { credentials: 'same-origin' });
    const body = await refreshed.json();
    if (refreshed.ok) {
      setImportReview((current) => (current ? { ...current, generationReviews: body.generationReviews } : current));
    }
    showToast(decision === 'confirmed' ? 'Confirmation recorded.' : 'Flag upheld.');
  };

  const handleDeleteMaterial = async (id: string) => {
    if (!confirm('Are you sure you want to delete this material?')) return;
    try {
      const res = await fetch(`/api/admin/materials/${id}`, {
        credentials: 'same-origin', method: 'DELETE',
        headers: { },
      });
      if (!res.ok) throw new Error('Deletion failed.');
      showToast('Material deleted successfully.');
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Admin Header Bar */}
      <div className="bg-ink-900 text-white rounded-2xl p-5 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-ink-800 border border-ink-700 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-success-500" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-base font-bold text-white tracking-tight">
                IELTS Admin Content CMS
              </h2>
              <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-success-500/20 text-success-500 border border-success-500/30">
                {adminUser.role}
              </span>
            </div>
            <p className="text-xs text-ink-400">
              Authenticated as <span className="font-semibold text-ink-200">{adminUser.name}</span> ({adminUser.username})
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Create Material Quick Menu */}
          <div className="flex items-center space-x-1.5 bg-ink-800 p-1 rounded-xl border border-ink-700">
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('speaking');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-danger-500 hover:bg-ink-700 transition-colors"
            >
              <Mic className="w-3.5 h-3.5 text-danger-500" />
              <span>+ Speaking</span>
            </button>
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('reading');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-success-500 hover:bg-ink-700 transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5 text-success-500" />
              <span>+ Reading</span>
            </button>
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('listening');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-brand-300 hover:bg-ink-700 transition-colors"
            >
              <Headphones className="w-3.5 h-3.5 text-brand-400" />
              <span>+ Listening</span>
            </button>
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('writing');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-warning-500 hover:bg-ink-700 transition-colors"
            >
              <Edit3 className="w-3.5 h-3.5 text-warning-500" />
              <span>+ Writing</span>
            </button>
            <button
              id="btn-import-cdi-html"
              onClick={() => {
                setEditingItem(null);
                setImportReview(null);
                setEditorMode('import');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-brand-200 hover:bg-ink-700 transition-colors"
            >
              <FileCode className="w-3.5 h-3.5 text-brand-300" />
              <span>Import HTML</span>
            </button>
            <button
              id="btn-new-full-cdi"
              onClick={() => {
                setEditingItem(null);
                setEditingBundleId(null);
                setEditorMode('bundle');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white bg-brand-600 hover:bg-brand-500 transition-colors shadow-xs"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>+ Full CDI</span>
            </button>
          </div>

          <button
            onClick={onLogout}
            className="p-2 text-ink-400 hover:text-white rounded-xl hover:bg-ink-800 transition-colors"
            title="Sign out of Administrator CMS"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Toast Notification */}
      {notification && (
        <div className="p-3 bg-success-50 border border-success-50 rounded-xl flex items-center space-x-2 text-success-700 text-xs font-semibold shadow-xs animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-success-500 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* Active Editor Drawer / Modal */}
      {editorMode !== 'none' && (
        <div className="bg-white border border-ink-200 rounded-2xl p-6 shadow-xl relative">
          {editorMode === 'speaking' && (
            <AdminSpeakingEditor
              initialData={editingItem}
              onSave={handleSaveMaterial}
              onCancel={() => {
                setEditorMode('none');
                setEditingItem(null);
              }}
            />
          )}

          {editorMode === 'reading' && (
            <AdminReadingEditor
              initialData={editingItem}
              onSave={handleSaveMaterial}
              onCancel={() => {
                setEditorMode('none');
                setEditingItem(null);
              }}
            />
          )}

          {editorMode === 'listening' && (
            <AdminListeningEditor
              initialData={editingItem}
              onSave={handleSaveMaterial}
              onCancel={() => {
                setEditorMode('none');
                setEditingItem(null);
              }}
            />
          )}

          {editorMode === 'writing' && (
            <AdminWritingEditor
              initialData={editingItem}
              onSave={handleSaveMaterial}
              onCancel={() => {
                setEditorMode('none');
                setEditingItem(null);
              }}
            />
          )}

          {editorMode === 'import' && !importReview && (
            <AdminImportStart
              onParsed={(result, sourceHtml, sourceAssetId) =>
                setImportReview(buildReviewState(result, { sourceHtml, sourceAssetId }))
              }
              onCancel={() => {
                setEditorMode('none');
                setImportReview(null);
              }}
            />
          )}

          {editorMode === 'import' && importReview && (
            <AdminImportReview
              state={importReview}
              onChange={setImportReview}
              onSaveDraft={handleSaveImportedDraft}
              onReviewGenerated={handleReviewGenerated}
              onCancel={() => {
                setEditorMode('none');
                setImportReview(null);
              }}
            />
          )}

          {editorMode === 'bundle' && (
            <AdminBundleBuilder
              bundleId={editingBundleId}
              onClose={() => {
                setEditorMode('none');
                setEditingBundleId(null);
              }}
              onChanged={fetchData}
              onToast={showToast}
            />
          )}
        </div>
      )}

      {/* Main Tabs Navigation */}
      <div className="flex items-center justify-between border-b border-ink-200 pb-3">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setActiveTab('materials')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'materials'
                ? 'bg-ink-900 text-white shadow-sm'
                : 'text-ink-600 hover:text-ink-900 hover:bg-ink-100'
            }`}
          >
            Material Repository ({materials.length})
          </button>
          <button
            id="tab-bundles"
            onClick={() => setActiveTab('bundles')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'bundles'
                ? 'bg-ink-900 text-white shadow-sm'
                : 'text-ink-600 hover:text-ink-900 hover:bg-ink-100'
            }`}
          >
            Full CDI Bundles ({bundles.length})
          </button>
          <button
            id="tab-source-library"
            onClick={() => setActiveTab('sources')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'sources'
                ? 'bg-ink-900 text-white shadow-sm'
                : 'text-ink-600 hover:text-ink-900 hover:bg-ink-100'
            }`}
          >
            Source Library
          </button>
          <button
            onClick={() => setActiveTab('analytics')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'analytics'
                ? 'bg-ink-900 text-white shadow-sm'
                : 'text-ink-600 hover:text-ink-900 hover:bg-ink-100'
            }`}
          >
            Repository Stats
          </button>
        </div>

        {activeTab === 'materials' && (
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-ink-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search materials..."
              className="pl-8 pr-3 py-1.5 text-xs bg-ink-50 border border-ink-200 rounded-lg w-48 sm:w-64 focus:bg-white focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Materials Tab */}
      {activeTab === 'materials' && (
        <AdminMaterialCatalog
          materials={materials}
          searchQuery={searchQuery}
          onPreview={setPreviewMaterial}
          onOpenGeneratedReview={(item) => {
            loadGeneratedReview(item.id)
              .then((state) => {
                setImportReview(state);
                setEditorMode('import');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              })
              .catch((error: unknown) => {
                showToast(error instanceof Error ? error.message : 'The draft could not be opened.');
              });
          }}
          onEdit={(item) => {
            setEditingItem(item);
            setEditorMode(item.section as 'speaking' | 'reading' | 'listening' | 'writing');
          }}
          onDelete={(item) => handleDeleteMaterial(item.id)}
          onChanged={fetchData}
          onToast={showToast}
        />
      )}

      {/* Bundles Tab */}
      {activeTab === 'bundles' && (
        <AdminBundleCatalog
          onEdit={(id) => {
            setEditingItem(null);
            setEditingBundleId(id);
            setEditorMode('bundle');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          onChanged={fetchData}
          onToast={showToast}
        />
      )}

      {/* Source Library Tab */}
      {activeTab === 'sources' && (
        <AdminSourceLibrary
          onToast={showToast}
          onMaterialsChanged={fetchData}
          onOpenReview={(state) => {
            setImportReview(state);
            setEditorMode('import');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}

      {/* Analytics Tab */}
      {activeTab === 'analytics' && stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 bg-white border border-ink-200 rounded-xl">
            <span className="text-xs text-ink-500 font-semibold block mb-1">Total Official Materials</span>
            <div className="text-2xl font-extrabold text-ink-900">{stats.totalMaterials}</div>
            <div className="text-[11px] text-success-500 mt-1 font-medium">{stats.publishedMaterials} published online</div>
          </div>

          <div className="p-4 bg-white border border-ink-200 rounded-xl">
            <span className="text-xs text-ink-500 font-semibold block mb-1">Full CDI Simulations</span>
            <div className="text-2xl font-extrabold text-brand-600">{stats.totalBundles}</div>
            <div className="text-[11px] text-ink-400 mt-1 font-medium">Assembled bundles, in any status</div>
          </div>

          <div className="p-4 bg-white border border-ink-200 rounded-xl">
            <span className="text-xs text-ink-500 font-semibold block mb-1">Uploaded Exam Assets</span>
            <div className="text-2xl font-extrabold text-ink-900">{stats.uploadedFilesCount}</div>
            <div className="text-[11px] text-ink-400 mt-1 font-medium">
              {(stats.uploadedTotalBytes / (1024 * 1024)).toFixed(1)} MB storage used
            </div>
          </div>

          <div className="p-4 bg-white border border-ink-200 rounded-xl">
            <span className="text-xs text-ink-500 font-semibold block mb-1">Skills Distribution</span>
            <div className="text-xs text-ink-600 space-y-1 mt-2">
              <div className="flex justify-between">
                <span>Listening:</span>
                <span className="font-bold">{stats.bySection.listening}</span>
              </div>
              <div className="flex justify-between">
                <span>Reading:</span>
                <span className="font-bold">{stats.bySection.reading}</span>
              </div>
              <div className="flex justify-between">
                <span>Writing:</span>
                <span className="font-bold">{stats.bySection.writing}</span>
              </div>
              <div className="flex justify-between">
                <span>Speaking:</span>
                <span className="font-bold">{stats.bySection.speaking}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewMaterial && <AdminPreviewModal material={previewMaterial} onClose={() => setPreviewMaterial(null)} />}
    </div>
  );
};
