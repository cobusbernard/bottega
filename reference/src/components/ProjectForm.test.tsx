import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ProjectForm from './ProjectForm';

// Mock the api module so tests don't make real HTTP calls
vi.mock('../utils/api', () => ({
  api: {
    forgeConnections: {
      listEnabled: vi.fn(),
    },
  },
}));

import { api } from '../utils/api';

// Minimal ForgeConnectionRow fixture
const mockConnections = [
  { id: 1, type: 'github' as const, name: 'GitHub Cloud', base_url: 'https://github.com', enabled: 1, created_at: '' },
  { id: 2, type: 'forgejo' as const, name: 'Self-hosted Forgejo', base_url: 'https://git.example.com', enabled: 1, created_at: '' },
];

function buildMockResponse(data: unknown, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(data),
  } as Response);
}

describe('ProjectForm', () => {
  const baseProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no connections
    vi.mocked(api.forgeConnections.listEnabled).mockReturnValue(
      buildMockResponse([])    );
  });

  it('renders the form when open', async () => {
    await act(async () => {
      render(<ProjectForm {...baseProps} />);
    });
    expect(screen.getByText('Create New Project')).toBeInTheDocument();
  });

  it('returns null when closed', async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ProjectForm {...baseProps} isOpen={false} />));
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders forge select when enabled connections are returned', async () => {
    vi.mocked(api.forgeConnections.listEnabled).mockReturnValue(
      buildMockResponse(mockConnections)    );

    render(<ProjectForm {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Forge')).toBeInTheDocument();
    });

    expect(screen.getByText('GitHub Cloud')).toBeInTheDocument();
    expect(screen.getByText('Self-hosted Forgejo')).toBeInTheDocument();
  });

  it('does not render forge select when no connections are available', async () => {
    vi.mocked(api.forgeConnections.listEnabled).mockReturnValue(
      buildMockResponse([])    );

    render(<ProjectForm {...baseProps} />);

    // Give the effect time to run
    await waitFor(() => {
      expect(api.forgeConnections.listEnabled).toHaveBeenCalled();
    });

    expect(screen.queryByLabelText('Forge')).not.toBeInTheDocument();
  });

  it('submits forge_connection_id when a connection is selected', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(api.forgeConnections.listEnabled).mockReturnValue(
      buildMockResponse(mockConnections)    );

    render(<ProjectForm {...baseProps} onSubmit={onSubmit} />);

    // Fill required fields
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Test Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/your/project'), {
      target: { value: '/repos/test' },
    });

    // Wait for forge select to appear, then pick the second connection
    await waitFor(() => {
      expect(screen.getByLabelText('Forge')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('Forge'), {
      target: { value: '2' },
    });

    fireEvent.submit(screen.getByRole('button', { name: 'Create Project' }).closest('form')!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Test Project',
        repoFolderPath: '/repos/test',
        forgeConnectionId: 2,
      });
    });
  });

  it('submits forgeConnectionId as null when "None" is selected', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(api.forgeConnections.listEnabled).mockReturnValue(
      buildMockResponse(mockConnections)    );

    render(<ProjectForm {...baseProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Test Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/your/project'), {
      target: { value: '/repos/test' },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Forge')).toBeInTheDocument();
    });

    // Leave the default "None" option selected
    fireEvent.submit(screen.getByRole('button', { name: 'Create Project' }).closest('form')!);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Test Project',
        repoFolderPath: '/repos/test',
        forgeConnectionId: null,
      });
    });
  });
});
