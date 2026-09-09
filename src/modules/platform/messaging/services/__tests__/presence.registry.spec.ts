import { PresenceRegistry } from '../presence.registry';

describe('PresenceRegistry', () => {
  const ADA = 'ada';
  const THREAD = 'conversation-1';

  it('reports the first socket as coming online and the last as going offline', () => {
    const registry = new PresenceRegistry();

    expect(registry.add(ADA, 'phone')).toBe(true);
    expect(registry.add(ADA, 'tablet')).toBe(false);
    expect(registry.remove(ADA, 'phone')).toBe(false);
    expect(registry.isOnline(ADA)).toBe(true);
    expect(registry.remove(ADA, 'tablet')).toBe(true);
    expect(registry.isOnline(ADA)).toBe(false);
  });

  // A connected member is not a member who is reading. Push suppression keys off the thread being
  // open, so a client that never sends `conversation.open` keeps every push it would have had.
  it('treats a connected member with no open thread as unattended', () => {
    const registry = new PresenceRegistry();

    registry.add(ADA, 'phone');

    expect(registry.isOnline(ADA)).toBe(true);
    expect(registry.isViewing(ADA, THREAD)).toBe(false);
  });

  it('silences only the thread that is actually on screen', () => {
    const registry = new PresenceRegistry();

    registry.add(ADA, 'phone');
    registry.openThread(ADA, 'phone', THREAD);

    expect(registry.isViewing(ADA, THREAD)).toBe(true);
    expect(registry.isViewing(ADA, 'conversation-2')).toBe(false);
  });

  it('forgets the open thread when the member leaves it', () => {
    const registry = new PresenceRegistry();

    registry.add(ADA, 'phone');
    registry.openThread(ADA, 'phone', THREAD);
    registry.closeThread(ADA, 'phone');

    expect(registry.isViewing(ADA, THREAD)).toBe(false);
  });

  // Backgrounding does not always close a thread cleanly; the socket dying has to.
  it('forgets the open thread when the socket goes', () => {
    const registry = new PresenceRegistry();

    registry.add(ADA, 'phone');
    registry.openThread(ADA, 'phone', THREAD);
    registry.remove(ADA, 'phone');

    expect(registry.isViewing(ADA, THREAD)).toBe(false);
  });

  it('keeps one device reading from silencing the others', () => {
    const registry = new PresenceRegistry();

    registry.add(ADA, 'phone');
    registry.add(ADA, 'tablet');
    registry.openThread(ADA, 'tablet', THREAD);
    registry.remove(ADA, 'tablet');

    expect(registry.isOnline(ADA)).toBe(true);
    expect(registry.isViewing(ADA, THREAD)).toBe(false);
  });
});
