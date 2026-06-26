import { Fragment, useState, useEffect, useCallback } from 'react';
import { Trash2, ToggleLeft, ToggleRight, Plus, KeyRound } from 'lucide-react';
import { Button } from '../ui/button';
import { api } from '../../utils/api';
import type { ForgeConnectionResponse } from '../../../shared/types/db';
import type { ApiError } from '../../../shared/api/_common';

function ForgeConnections() {
  const [connections, setConnections] = useState<ForgeConnectionResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<'github' | 'forgejo'>('github');
  const [formName, setFormName] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('https://github.com');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Per-connection bot token UI state: connId → { expanded, tokenInput, saving, tokenError }
  const [tokenState, setTokenState] = useState<
    Record<number, { expanded: boolean; tokenInput: string; saving: boolean; tokenError: string }>
  >({});

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await api.admin.listForgeConnections();
      if (response.ok) {
        const data = await response.json();
        setConnections(data);
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to load forge connections');
      }
    } catch {
      setError('Failed to load forge connections');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTypeChange = (type: 'github' | 'forgejo') => {
    setFormType(type);
    setFormBaseUrl(type === 'github' ? 'https://github.com' : '');
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formBaseUrl.trim()) {
      setFormError('Name and Base URL are required');
      return;
    }
    setIsSubmitting(true);
    setFormError('');
    try {
      const response = await api.admin.createForgeConnection(
        formType,
        formName.trim(),
        formBaseUrl.trim()
      );
      if (response.ok) {
        setShowForm(false);
        setFormName('');
        setFormBaseUrl('https://github.com');
        setFormType('github');
        await load();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setFormError(errorData.error || 'Failed to create connection');
      }
    } catch {
      setFormError('Failed to create connection');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (conn: ForgeConnectionResponse) => {
    try {
      const response = await api.admin.setForgeConnectionEnabled(conn.id, conn.enabled === 0);
      if (response.ok) {
        await load();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to update connection');
      }
    } catch {
      setError('Failed to update connection');
    }
  };

  const handleDelete = async (conn: ForgeConnectionResponse) => {
    if (!confirm(`Delete forge connection "${conn.name}"?`)) return;
    try {
      const response = await api.admin.deleteForgeConnection(conn.id);
      if (response.ok) {
        await load();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to delete connection');
      }
    } catch {
      setError('Failed to delete connection');
    }
  };

  const getTokenState = (id: number) =>
    tokenState[id] ?? { expanded: false, tokenInput: '', saving: false, tokenError: '' };

  const setTokenField = (
    id: number,
    patch: Partial<{ expanded: boolean; tokenInput: string; saving: boolean; tokenError: string }>,
  ) => {
    setTokenState((prev) => ({ ...prev, [id]: { ...getTokenState(id), ...patch } }));
  };

  const handleSaveToken = async (conn: ForgeConnectionResponse) => {
    const ts = getTokenState(conn.id);
    if (!ts.tokenInput.trim()) {
      setTokenField(conn.id, { tokenError: 'Token must not be empty' });
      return;
    }
    setTokenField(conn.id, { saving: true, tokenError: '' });
    try {
      const response = await api.admin.setConnectionBotToken(conn.id, ts.tokenInput.trim());
      if (response.ok) {
        setTokenField(conn.id, { tokenInput: '', expanded: false, saving: false });
        await load();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setTokenField(conn.id, { tokenError: errorData.error || 'Failed to save token', saving: false });
      }
    } catch {
      setTokenField(conn.id, { tokenError: 'Failed to save token', saving: false });
    }
  };

  const handleClearToken = async (conn: ForgeConnectionResponse) => {
    if (!confirm(`Clear bot token for "${conn.name}"?`)) return;
    try {
      const response = await api.admin.deleteConnectionBotToken(conn.id);
      if (response.ok) {
        await load();
      } else {
        const errorData = (await response.json()) as unknown as ApiError;
        setError(errorData.error || 'Failed to clear token');
      }
    } catch {
      setError('Failed to clear token');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-foreground">Forge Connections</h2>
        <Button onClick={() => setShowForm((v) => !v)} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add Connection
        </Button>
      </div>

      {error && (
        <div className="p-3 text-sm text-red-500 bg-red-500/10 rounded-md">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {showForm && (
        <form onSubmit={(e) => { void handleAdd(e); }} className="p-4 border border-border rounded-md space-y-3 bg-card">
          <h3 className="text-sm font-medium text-foreground">New Forge Connection</h3>
          {formError && (
            <p className="text-xs text-red-500">{formError}</p>
          )}
          <div className="space-y-2">
            <label className="block text-sm text-muted-foreground">Type</label>
            <select
              value={formType}
              onChange={(e) => handleTypeChange(e.target.value as 'github' | 'forgejo')}
              className="w-full text-sm border border-input bg-background rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="github">GitHub</option>
              <option value="forgejo">Forgejo</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="block text-sm text-muted-foreground">Name</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. My GitHub"
              className="w-full text-sm border border-input bg-background rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm text-muted-foreground">Base URL</label>
            <input
              type="text"
              value={formBaseUrl}
              onChange={(e) => setFormBaseUrl(e.target.value)}
              placeholder="https://github.com"
              className="w-full text-sm border border-input bg-background rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { setShowForm(false); setFormError(''); }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? 'Adding...' : 'Add'}
            </Button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">Name</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">Type</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">Base URL</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">Status</th>
                <th className="text-left py-3 px-4 font-medium text-muted-foreground">Bot Token</th>
                <th className="text-right py-3 px-4 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((conn) => {
                const ts = getTokenState(conn.id);
                return (
                  <Fragment key={conn.id}>
                    <tr className="border-b border-border/50 hover:bg-accent/50">
                      <td className="py-3 px-4 font-medium text-foreground">{conn.name}</td>
                      <td className="py-3 px-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground capitalize">
                          {conn.type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-muted-foreground text-xs truncate max-w-xs">{conn.base_url}</td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          conn.enabled
                            ? 'bg-green-500/10 text-green-500'
                            : 'bg-red-500/10 text-red-500'
                        }`}>
                          {conn.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`text-xs ${conn.botTokenConfigured ? 'text-green-500' : 'text-muted-foreground'}`}>
                          {conn.botTokenConfigured ? 'configured' : 'not configured'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setTokenField(conn.id, { expanded: !ts.expanded, tokenInput: '', tokenError: '' })}
                            title="Manage bot token"
                            aria-label="Manage bot token"
                          >
                            <KeyRound className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => { void handleToggle(conn); }}
                            title={conn.enabled ? 'Disable' : 'Enable'}
                          >
                            {conn.enabled ? (
                              <ToggleRight className="h-4 w-4 text-green-500" />
                            ) : (
                              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => { void handleDelete(conn); }}
                            title="Delete connection"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {ts.expanded && (
                      <tr className="bg-muted/30 border-b border-border/50">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="space-y-2">
                            <p className="text-xs text-muted-foreground">
                              Bot token — write-only. Used by the webhook to look up PR branches and review comments via the Forgejo API.
                            </p>
                            {ts.tokenError && (
                              <p className="text-xs text-red-500">{ts.tokenError}</p>
                            )}
                            <div className="flex gap-2 items-center">
                              <input
                                type="password"
                                value={ts.tokenInput}
                                onChange={(e) => setTokenField(conn.id, { tokenInput: e.target.value })}
                                placeholder="Paste token here"
                                aria-label="Bot token"
                                className="flex-1 text-sm border border-input bg-background rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                              <Button
                                size="sm"
                                onClick={() => { void handleSaveToken(conn); }}
                                disabled={ts.saving}
                              >
                                {ts.saving ? 'Saving...' : 'Save'}
                              </Button>
                              {conn.botTokenConfigured && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => { void handleClearToken(conn); }}
                                  className="text-destructive hover:text-destructive"
                                >
                                  Clear
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setTokenField(conn.id, { expanded: false, tokenInput: '', tokenError: '' })}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {connections.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No forge connections configured
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ForgeConnections;
