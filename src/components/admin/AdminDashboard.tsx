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
  Search,
  CheckCircle2,
  Clock,
  AlertCircle
} from 'lucide-react';
import { AdminUser, AdminMaterial, FullCdiBundle, AdminStats } from '../../types/admin';
import { AdminSpeakingEditor } from './AdminSpeakingEditor';
import { AdminReadingEditor } from './AdminReadingEditor';
import { AdminListeningEditor } from './AdminListeningEditor';
import { AdminWritingEditor } from './AdminWritingEditor';
import { AdminCdiBundleBuilder } from './AdminCdiBundleBuilder';
import { AdminPreviewModal } from './AdminPreviewModal';

interface AdminDashboardProps {
  adminUser: AdminUser;
  adminToken: string;
  onLogout: () => void;
}

type TabKey = 'materials' | 'bundles' | 'analytics';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  adminUser,
  adminToken,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('materials');
  const [activeSection, setActiveSection] = useState<'all' | 'speaking' | 'reading' | 'listening' | 'writing'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [materials, setMaterials] = useState<AdminMaterial[]>([]);
  const [bundles, setBundles] = useState<FullCdiBundle[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  // Editor states
  const [editorMode, setEditorMode] = useState<
    'none' | 'speaking' | 'reading' | 'listening' | 'writing' | 'bundle'
  >('none');
  const [editingItem, setEditingItem] = useState<any | null>(null);

  // Preview state
  const [previewMaterial, setPreviewMaterial] = useState<AdminMaterial | null>(null);
  const [previewBundle, setPreviewBundle] = useState<any | null>(null);

  // Fetch initial data
  const fetchData = async () => {
    setLoading(true);
    try {
      const [matRes, bunRes, statRes] = await Promise.all([
        fetch('/api/admin/materials', { headers: { Authorization: `Bearer ${adminToken}` } }),
        fetch('/api/admin/bundles', { headers: { Authorization: `Bearer ${adminToken}` } }),
        fetch('/api/admin/stats', { headers: { Authorization: `Bearer ${adminToken}` } }),
      ]);

      if (matRes.ok) {
        const d = await matRes.json();
        setMaterials(d.materials || []);
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
  }, [adminToken]);

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
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
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

  const handleDeleteMaterial = async (id: string) => {
    if (!confirm('Are you sure you want to delete this material?')) return;
    try {
      const res = await fetch(`/api/admin/materials/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error('Deletion failed.');
      showToast('Material deleted successfully.');
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  // CRUD for Bundle
  const handleSaveBundle = async (item: Partial<FullCdiBundle>) => {
    try {
      const method = item.id ? 'PUT' : 'POST';
      const url = item.id ? `/api/admin/bundles/${item.id}` : '/api/admin/bundles';

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify(item),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save CDI bundle.');

      showToast(`Successfully saved CDI Exam Bundle "${item.title}"`);
      setEditorMode('none');
      setEditingItem(null);
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteBundle = async (id: string) => {
    if (!confirm('Are you sure you want to delete this CDI exam bundle?')) return;
    try {
      const res = await fetch(`/api/admin/bundles/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error('Deletion failed.');
      showToast('CDI bundle deleted successfully.');
      fetchData();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handlePreviewBundle = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/bundles/${id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.ok) {
        const d = await res.json();
        setPreviewBundle(d);
      }
    } catch (err) {
      console.error('Failed to load bundle preview:', err);
    }
  };

  const filteredMaterials = materials.filter((m) => {
    const matchesSection = activeSection === 'all' || m.section === activeSection;
    const matchesSearch =
      !searchQuery ||
      m.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.theme?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesSection && matchesSearch;
  });

  const categorizedMaterials = {
    listening: materials.filter((m) => m.section === 'listening'),
    reading: materials.filter((m) => m.section === 'reading'),
    writing: materials.filter((m) => m.section === 'writing'),
    speaking: materials.filter((m) => m.section === 'speaking'),
  };

  return (
    <div className="space-y-6">
      {/* Top Admin Header Bar */}
      <div className="bg-slate-900 text-white rounded-2xl p-5 shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-base font-bold text-white tracking-tight">
                IELTS Admin Content CMS
              </h2>
              <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                {adminUser.role}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Authenticated as <span className="font-semibold text-slate-200">{adminUser.name}</span> ({adminUser.username})
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* Create Material Quick Menu */}
          <div className="flex items-center space-x-1.5 bg-slate-800 p-1 rounded-xl border border-slate-700">
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('speaking');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-300 hover:bg-slate-700 transition-colors"
            >
              <Mic className="w-3.5 h-3.5 text-rose-400" />
              <span>+ Speaking</span>
            </button>
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('reading');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-emerald-300 hover:bg-slate-700 transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
              <span>+ Reading</span>
            </button>
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('listening');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-300 hover:bg-slate-700 transition-colors"
            >
              <Headphones className="w-3.5 h-3.5 text-indigo-400" />
              <span>+ Listening</span>
            </button>
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('writing');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-amber-300 hover:bg-slate-700 transition-colors"
            >
              <Edit3 className="w-3.5 h-3.5 text-amber-400" />
              <span>+ Writing</span>
            </button>
            <button
              onClick={() => {
                setEditingItem(null);
                setEditorMode('bundle');
              }}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 transition-colors shadow-xs"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>+ Full CDI</span>
            </button>
          </div>

          <button
            onClick={onLogout}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
            title="Sign out of Administrator CMS"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Toast Notification */}
      {notification && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center space-x-2 text-emerald-800 text-xs font-semibold shadow-xs animate-in fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* Active Editor Drawer / Modal */}
      {editorMode !== 'none' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xl relative">
          {editorMode === 'speaking' && (
            <AdminSpeakingEditor
              initialData={editingItem}
              adminToken={adminToken}
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
              adminToken={adminToken}
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
              adminToken={adminToken}
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
              adminToken={adminToken}
              onSave={handleSaveMaterial}
              onCancel={() => {
                setEditorMode('none');
                setEditingItem(null);
              }}
            />
          )}

          {editorMode === 'bundle' && (
            <AdminCdiBundleBuilder
              initialData={editingItem}
              materials={categorizedMaterials}
              onSave={handleSaveBundle}
              onCancel={() => {
                setEditorMode('none');
                setEditingItem(null);
              }}
            />
          )}
        </div>
      )}

      {/* Main Tabs Navigation */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-3">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setActiveTab('materials')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'materials'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            Material Repository ({materials.length})
          </button>
          <button
            onClick={() => setActiveTab('bundles')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'bundles'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            Full CDI Bundles ({bundles.length})
          </button>
          <button
            onClick={() => setActiveTab('analytics')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
              activeTab === 'analytics'
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            Repository Stats
          </button>
        </div>

        {activeTab === 'materials' && (
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search materials..."
              className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg w-48 sm:w-64 focus:bg-white focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Materials Tab */}
      {activeTab === 'materials' && (
        <div className="space-y-4">
          {/* Section Filter Pills */}
          <div className="flex items-center space-x-1.5 overflow-x-auto pb-1">
            {(['all', 'speaking', 'reading', 'listening', 'writing'] as const).map((sec) => (
              <button
                key={sec}
                onClick={() => setActiveSection(sec)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                  activeSection === sec
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {sec} ({sec === 'all' ? materials.length : materials.filter((m) => m.section === sec).length})
              </button>
            ))}
          </div>

          {/* Materials Table/List */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
            {filteredMaterials.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs">
                No materials found matching criteria. Use the quick buttons above to upload new IELTS content.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredMaterials.map((item) => (
                  <div
                    key={item.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                  >
                    <div className="flex items-start space-x-3">
                      <div className="mt-1">
                        {item.section === 'speaking' && <Mic className="w-4 h-4 text-rose-500" />}
                        {item.section === 'reading' && <BookOpen className="w-4 h-4 text-emerald-500" />}
                        {item.section === 'listening' && <Headphones className="w-4 h-4 text-indigo-500" />}
                        {item.section === 'writing' && <Edit3 className="w-4 h-4 text-amber-500" />}
                      </div>

                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-bold text-slate-900">{item.title}</span>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              item.status === 'published'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>
                        <div className="flex items-center space-x-2 mt-1 text-[11px] text-slate-500">
                          <span className="capitalize font-medium">{item.section}</span>
                          <span>•</span>
                          <span>{item.module || 'Academic'} Module</span>
                          <span>•</span>
                          <span>Band {item.targetBand || '7.5'} Standard</span>
                          {item.theme && (
                            <>
                              <span>•</span>
                              <span className="text-slate-400">Theme: {item.theme}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-1 self-end sm:self-center">
                      <button
                        onClick={() => setPreviewMaterial(item)}
                        className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg text-xs flex items-center space-x-1"
                        title="Live candidate preview"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Preview</span>
                      </button>

                      <button
                        onClick={() => {
                          setEditingItem(item);
                          setEditorMode(item.section as any);
                        }}
                        className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg text-xs flex items-center space-x-1"
                        title="Edit material"
                      >
                        <Edit className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Edit</span>
                      </button>

                      <button
                        onClick={() => handleDeleteMaterial(item.id)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg"
                        title="Delete material"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bundles Tab */}
      {activeTab === 'bundles' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs divide-y divide-slate-100">
            {bundles.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs">
                No CDI Exam Bundles assembled yet. Click <strong>+ Full CDI</strong> to assemble a 4-skill mock test.
              </div>
            ) : (
              bundles.map((bundle) => (
                <div
                  key={bundle.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                >
                  <div className="flex items-start space-x-3">
                    <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-700 flex items-center justify-center font-bold text-xs mt-1">
                      CDI
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-slate-900">{bundle.title}</span>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            bundle.status === 'published'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {bundle.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 line-clamp-1 mt-0.5">{bundle.description}</p>
                      <div className="flex items-center space-x-2 mt-1 text-[11px] text-slate-400 font-medium">
                        <span>Total: ~{bundle.timings.listeningMinutes + bundle.timings.readingMinutes + bundle.timings.writingMinutes + bundle.timings.speakingMinutes} mins</span>
                        <span>•</span>
                        <span>{bundle.module.toUpperCase()}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-1 self-end sm:self-center">
                    <button
                      onClick={() => handlePreviewBundle(bundle.id)}
                      className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg text-xs flex items-center space-x-1"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Preview</span>
                    </button>

                    <button
                      onClick={() => {
                        setEditingItem(bundle);
                        setEditorMode('bundle');
                      }}
                      className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg text-xs flex items-center space-x-1"
                    >
                      <Edit className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>

                    <button
                      onClick={() => handleDeleteBundle(bundle.id)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Analytics Tab */}
      {activeTab === 'analytics' && stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 bg-white border border-slate-200 rounded-xl">
            <span className="text-xs text-slate-500 font-semibold block mb-1">Total Official Materials</span>
            <div className="text-2xl font-extrabold text-slate-900">{stats.totalMaterials}</div>
            <div className="text-[11px] text-emerald-600 mt-1 font-medium">{stats.publishedMaterials} published online</div>
          </div>

          <div className="p-4 bg-white border border-slate-200 rounded-xl">
            <span className="text-xs text-slate-500 font-semibold block mb-1">Full CDI Simulations</span>
            <div className="text-2xl font-extrabold text-indigo-600">{stats.totalBundles}</div>
            <div className="text-[11px] text-slate-400 mt-1 font-medium">Ready for real-time exam mode</div>
          </div>

          <div className="p-4 bg-white border border-slate-200 rounded-xl">
            <span className="text-xs text-slate-500 font-semibold block mb-1">Uploaded Exam Assets</span>
            <div className="text-2xl font-extrabold text-slate-900">{stats.uploadedFilesCount}</div>
            <div className="text-[11px] text-slate-400 mt-1 font-medium">
              {(stats.uploadedTotalBytes / (1024 * 1024)).toFixed(1)} MB storage used
            </div>
          </div>

          <div className="p-4 bg-white border border-slate-200 rounded-xl">
            <span className="text-xs text-slate-500 font-semibold block mb-1">Skills Distribution</span>
            <div className="text-xs text-slate-600 space-y-1 mt-2">
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
      {(previewMaterial || previewBundle) && (
        <AdminPreviewModal
          material={previewMaterial}
          bundle={previewBundle}
          onClose={() => {
            setPreviewMaterial(null);
            setPreviewBundle(null);
          }}
        />
      )}
    </div>
  );
};
