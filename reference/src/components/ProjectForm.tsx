/**
 * ProjectForm.tsx - Project Create Modal
 *
 * Modal form for creating a new project. Captures name, repo folder path,
 * and an optional forge connection (populated from enabled connections).
 * Project editing is done via the full ProjectEditPage.
 */

import { useState, useEffect, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { api } from '../utils/api';
import type { ForgeConnectionRow } from '../../shared/types/db';

export interface ProjectFormSubmitData {
  name: string;
  repoFolderPath: string;
  forgeConnectionId?: number | null;
}

export interface ProjectFormSubmitResult {
  success: boolean;
  error?: string;
}

export interface ProjectFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: ProjectFormSubmitData) => Promise<ProjectFormSubmitResult>;
  isSubmitting?: boolean;
}

function ProjectForm({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
}: ProjectFormProps) {
  const [name, setName] = useState('');
  const [repoFolderPath, setRepoFolderPath] = useState('');
  const [forgeConnectionId, setForgeConnectionId] = useState<number | null>(null);
  const [forgeConnections, setForgeConnections] = useState<ForgeConnectionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setRepoFolderPath('');
      setForgeConnectionId(null);
      setError(null);
      // Fetch enabled forge connections to populate the selector
      api.forgeConnections.listEnabled().then(async (res) => {
        if (res.ok) {
          const connections = await res.json();
          setForgeConnections(connections);
        }
      }).catch(() => {
        // Non-fatal — the forge selector just stays empty
      });
    }
  }, [isOpen]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Project name is required');
      return;
    }

    if (!repoFolderPath.trim()) {
      setError('Repository folder path is required');
      return;
    }

    try {
      const result = await onSubmit({
        name: name.trim(),
        repoFolderPath: repoFolderPath.trim(),
        forgeConnectionId,
      });

      if (!result.success) {
        setError(result.error || 'Failed to create project');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project';
      setError(message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-lg mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">
            Create New Project
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Error message */}
            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            {/* Project name */}
            <div className="space-y-2">
              <label htmlFor="project-name" className="text-sm font-medium text-foreground">
                Project Name
              </label>
              <Input
                id="project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Project"
                autoFocus
              />
            </div>

            {/* Repository folder path */}
            <div className="space-y-2">
              <label htmlFor="repo-path" className="text-sm font-medium text-foreground">
                Repository Folder Path
              </label>
              <Input
                id="repo-path"
                type="text"
                value={repoFolderPath}
                onChange={(e) => setRepoFolderPath(e.target.value)}
                placeholder="/path/to/your/project"
              />
            </div>

            {/* Forge connection (optional) */}
            {forgeConnections.length > 0 && (
              <div className="space-y-2">
                <label htmlFor="forge-connection" className="text-sm font-medium text-foreground">
                  Forge
                </label>
                <select
                  id="forge-connection"
                  value={forgeConnectionId ?? ''}
                  onChange={(e) =>
                    setForgeConnectionId(e.target.value ? Number(e.target.value) : null)
                  }
                  className="w-full text-sm bg-background border border-input rounded-md px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">None (GitHub default)</option>
                  {forgeConnections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      {conn.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="default"
                className="flex-1"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                    Creating...
                  </>
                ) : (
                  'Create Project'
                )}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default ProjectForm;
