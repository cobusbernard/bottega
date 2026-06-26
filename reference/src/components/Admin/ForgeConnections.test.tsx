import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ForgeConnections from './ForgeConnections';
import { api } from '../../utils/api';
import { mockTypedResponse } from '../../test/typedResponse';
import type { ForgeConnectionRow } from '../../../shared/types/db';

vi.mock('../../utils/api', () => ({
  api: {
    admin: {
      listForgeConnections: vi.fn(),
      createForgeConnection: vi.fn(),
      setForgeConnectionEnabled: vi.fn(),
      deleteForgeConnection: vi.fn(),
    },
  },
}));

const ok = <T,>(body: T) => mockTypedResponse(body);

const mockConnections: ForgeConnectionRow[] = [
  {
    id: 1,
    type: 'github',
    name: 'My GitHub',
    base_url: 'https://github.com',
    enabled: 1,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    type: 'forgejo',
    name: 'Self-hosted Forgejo',
    base_url: 'https://forgejo.example.com',
    enabled: 0,
    created_at: '2026-01-02T00:00:00Z',
  },
];

describe('ForgeConnections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the list of connections from a mocked fetch', async () => {
    vi.mocked(api.admin.listForgeConnections).mockResolvedValue(ok(mockConnections));

    render(<ForgeConnections />);

    expect(await screen.findByText('My GitHub')).toBeInTheDocument();
    expect(screen.getByText('Self-hosted Forgejo')).toBeInTheDocument();
    expect(screen.getByText('https://github.com')).toBeInTheDocument();
    expect(screen.getByText('https://forgejo.example.com')).toBeInTheDocument();
    expect(api.admin.listForgeConnections).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when no connections', async () => {
    vi.mocked(api.admin.listForgeConnections).mockResolvedValue(ok([]));

    render(<ForgeConnections />);

    expect(await screen.findByText(/no forge connections configured/i)).toBeInTheDocument();
  });

  it('shows the add form when "Add Connection" is clicked', async () => {
    vi.mocked(api.admin.listForgeConnections).mockResolvedValue(ok([]));

    render(<ForgeConnections />);

    await screen.findByText(/no forge connections configured/i);
    fireEvent.click(screen.getByRole('button', { name: /add connection/i }));

    expect(screen.getByText('New Forge Connection')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e.g. My GitHub/i)).toBeInTheDocument();
  });

  it('submits the add form and reloads the list', async () => {
    const newConn: ForgeConnectionRow = {
      id: 3,
      type: 'github',
      name: 'New Forge',
      base_url: 'https://github.com',
      enabled: 1,
      created_at: '2026-01-03T00:00:00Z',
    };

    vi.mocked(api.admin.listForgeConnections)
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([newConn]));
    vi.mocked(api.admin.createForgeConnection).mockResolvedValue(ok(newConn));

    render(<ForgeConnections />);

    await screen.findByText(/no forge connections configured/i);
    fireEvent.click(screen.getByRole('button', { name: /add connection/i }));

    fireEvent.change(screen.getByPlaceholderText(/e.g. My GitHub/i), {
      target: { value: 'New Forge' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(api.admin.createForgeConnection).toHaveBeenCalledWith(
      'github',
      'New Forge',
      'https://github.com'
    ));
    await screen.findByText('New Forge');
  });

  it('shows an error message on fetch failure', async () => {
    vi.mocked(api.admin.listForgeConnections).mockResolvedValue(
      mockTypedResponse({ error: 'Unauthorized' } as never, { ok: false, status: 401 })
    );

    render(<ForgeConnections />);

    expect(await screen.findByText(/Unauthorized/i)).toBeInTheDocument();
  });
});
