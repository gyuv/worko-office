import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateState } from '../lib/platform';
import { AboutUpdates, UpdateBanner } from './UpdateBanner';

function mountBridge(initial: DesktopUpdateState) {
  let push: (s: DesktopUpdateState) => void = () => {};
  const updates = {
    get: vi.fn(async () => initial), check: vi.fn(async (): Promise<DesktopUpdateState> => ({ phase: 'current', current: '1.1.0' })),
    install: vi.fn(async () => true), onState: vi.fn((cb: (s: DesktopUpdateState) => void) => { push = cb; return () => {}; }),
  };
  (window as unknown as { worko: unknown }).worko = { platform: 'desktop', apiBase: 'x', updates };
  return { updates, push: (s: DesktopUpdateState) => act(() => push(s)) };
}
afterEach(() => { delete (window as unknown as { worko?: unknown }).worko; });

describe('in-app updates (desktop)', () => {
  it('shows download progress, then offers a one-click restart', async () => {
    const { updates, push } = mountBridge({ phase: 'idle', current: '1.1.0' });
    render(<UpdateBanner />);
    push({ phase: 'downloading', current: '1.1.0', info: { version: '1.2.0', notes: '' }, progress: 40 });
    expect(await screen.findByText(/Downloading Worko 1\.2\.0… 40%/)).toBeTruthy();
    push({ phase: 'ready', current: '1.1.0', info: { version: '1.2.0', notes: '' }, file: 'f' });
    fireEvent.click(await screen.findByRole('button', { name: /Restart & update|Open installer/ }));
    expect(updates.install).toHaveBeenCalled();
  });
  it('about card shows the version and checks on demand', async () => {
    const { updates } = mountBridge({ phase: 'idle', current: '1.1.0' });
    render(<AboutUpdates />);
    expect(await screen.findByText('Version 1.1.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Check for updates/ }));
    expect(await screen.findByText('You have the latest version.')).toBeTruthy();
    expect(updates.check).toHaveBeenCalled();
  });
});
