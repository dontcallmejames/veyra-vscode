import { describe, it, expect } from 'vitest';
import { FloorManager } from '../src/floor.js';

describe('FloorManager', () => {
  it('grants the floor when free', async () => {
    const fm = new FloorManager();
    const handle = await fm.acquire('claude');
    expect(fm.holder()).toBe('claude');
    handle.release();
    expect(fm.holder()).toBeNull();
  });

  it('queues a second acquire until the first releases', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');
    const order: string[] = [];

    const secondPromise = fm.acquire('gemini').then((handle) => {
      order.push('gemini');
      handle.release();
    });

    order.push('claude-released');
    first.release();

    await secondPromise;
    expect(order).toEqual(['claude-released', 'gemini']);
  });

  it('emits a status event when the holder changes', async () => {
    const fm = new FloorManager();
    const events: (string | null)[] = [];
    fm.onChange((h) => events.push(h));

    const handle = await fm.acquire('claude');
    handle.release();

    expect(events).toEqual(['claude', null]);
  });

  it('release is idempotent', async () => {
    const fm = new FloorManager();
    const handle = await fm.acquire('claude');
    handle.release();
    handle.release(); // should not throw or mutate state
    expect(fm.holder()).toBeNull();
  });

  it('reports queue length', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');
    void fm.acquire('codex');
    void fm.acquire('gemini');
    expect(fm.queueLength()).toBe(2);
    first.release();
  });

  it('drainQueue resolves all waiters with no-op handles', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');

    const queued1 = fm.acquire('codex');
    const queued2 = fm.acquire('gemini');
    expect(fm.queueLength()).toBe(2);

    fm.drainQueue();
    expect(fm.queueLength()).toBe(0);

    // Queued promises still resolve so callers don't hang.
    const handle1 = await queued1;
    const handle2 = await queued2;
    // Releasing a drained handle is a no-op (doesn't grant the floor to anyone).
    handle1.release();
    handle2.release();
    expect(fm.holder()).toBe('claude'); // first still holds

    first.release();
    expect(fm.holder()).toBeNull();
  });

  it('drainQueue exposes the agents that were queued', async () => {
    const fm = new FloorManager();
    const first = await fm.acquire('claude');
    void fm.acquire('codex');
    void fm.acquire('gemini');
    const drained = fm.drainQueue();
    expect(drained).toEqual(['codex', 'gemini']);
    first.release();
  });
});
