import React, { useState } from 'react';
import { Shield, Lock, User, AlertCircle, ArrowRight } from 'lucide-react';
import { AdminUser } from '../../types/admin';

interface AdminLoginProps {
  onLoginSuccess: (admin: AdminUser) => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed.');
      if (!data.admin) throw new Error('Authentication response is invalid.');
      localStorage.setItem('prep_admin_user', JSON.stringify(data.admin));
      onLoginSuccess(data.admin);
    } catch (err: any) {
      setError(err.message || 'Unable to sign in as administrator.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto my-12 p-8 bg-white border border-ink-200 rounded-2xl shadow-xl">
      <div className="flex items-center space-x-3 mb-6">
        <div className="w-12 h-12 rounded-xl bg-ink-900 text-white flex items-center justify-center shadow-md">
          <Shield className="w-6 h-6 text-success-500" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-ink-900 tracking-tight">Examiner & Admin Portal</h2>
          <p className="text-xs text-ink-500 font-medium">Restricted Access • Content Management System</p>
        </div>
      </div>

      {error && (
        <div className="mb-5 p-3.5 rounded-xl bg-danger-50 border border-danger-50 flex items-start space-x-2 text-danger-700 text-xs font-medium">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-bold text-ink-700 uppercase tracking-wider mb-1.5">
            Admin Account Username
          </label>
          <div className="relative">
            <User className="w-4 h-4 text-ink-400 absolute left-3 top-3" />
            <input
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. admin or examiner"
              className="w-full pl-9 pr-3 py-2 text-sm bg-ink-50 border border-ink-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-ink-900 font-medium"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold text-ink-700 uppercase tracking-wider mb-1.5">
            Password / Secret Key
          </label>
          <div className="relative">
            <Lock className="w-4 h-4 text-ink-400 absolute left-3 top-3" />
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full pl-9 pr-3 py-2 text-sm bg-ink-50 border border-ink-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-ink-900 font-medium"
            />
          </div>
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl bg-ink-900 hover:bg-ink-800 text-white font-semibold text-sm flex items-center justify-center space-x-2 shadow-sm transition-all disabled:opacity-50"
          >
            {loading ? (
              <span>Verifying Credentials...</span>
            ) : (
              <>
                <span>Sign In to Admin Panel</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </form>

      <div className="mt-6 pt-4 border-t border-ink-100 text-[11px] text-ink-400 text-center leading-relaxed">
        Administrator credentials are provisioned through the server environment and are
        never displayed in the client.
      </div>
    </div>
  );
};
