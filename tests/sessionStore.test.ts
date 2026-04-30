import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore } from '../src/sessionStore.js';
import type { Session, UserMessage } from '../src/shared/protocol.js';

const fsState = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsState.has(String(p)),
  readFileSync: (p: string) => {
    const v = fsState.get(String(p));
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn(async (p: string, content: string) => fsState.set(String(p), content)),
    rename: vi.fn(async (from: string, to: string) => {
      const v = fsState.get(String(from));
      if (v !== undefined) {
        fsState.set(String(to), v);
        fsState.delete(String(from));
      }
    }),
  },
}));

beforeEach(() => {
  fsState.clear();
  vi.useFakeTimers();
});

const FOLDER = '/fake/workspace';
const FILE = '/fake/workspace/.vscode/agent-chat/sessions.json';

const sampleUser: UserMessage = {
  id: 'u1',
  role: 'user',
  text: 'hello',
  timestamp: 1000,
};

describe('SessionStore', () => {
  it('returns an empty session when file does not exist', async () => {
    const store = new SessionStore(FOLDER);
    const session = await store.load();
    expect(session).toEqual({ version: 1, messages: [] });
  });

  it('appendUser schedules a debounced write', async () => {
    const store = new SessionStore(FOLDER);
    await store.load();
    store.appendUser(sampleUser);
    expect(fsState.has(FILE)).toBe(false);
    vi.advanceTimersByTime(200);
    await Promise.resolve(); // let the queued write settle
    expect(fsState.has(FILE)).toBe(true);
    const parsed = JSON.parse(fsState.get(FILE)!) as Session;
    expect(parsed.messages).toEqual([sampleUser]);
  });

  it('flush writes synchronously', async () => {
    const store = new SessionStore(FOLDER);
    await store.load();
    store.appendUser(sampleUser);
    await store.flush();
    expect(fsState.has(FILE)).toBe(true);
  });

  it('round-trips: write, reload, equal', async () => {
    const store1 = new SessionStore(FOLDER);
    await store1.load();
    store1.appendUser(sampleUser);
    await store1.flush();

    const store2 = new SessionStore(FOLDER);
    const reloaded = await store2.load();
    expect(reloaded.messages).toEqual([sampleUser]);
  });

  it('returns empty session and warns when JSON is corrupted', async () => {
    fsState.set(FILE, '{not valid json');
    const store = new SessionStore(FOLDER);
    const session = await store.load();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      role: 'system',
      kind: 'error',
      text: expect.stringContaining('corrupted'),
    });
  });

  it('coalesces multiple appends into one write', async () => {
    const store = new SessionStore(FOLDER);
    await store.load();
    store.appendUser({ ...sampleUser, id: 'u1' });
    store.appendUser({ ...sampleUser, id: 'u2' });
    store.appendUser({ ...sampleUser, id: 'u3' });
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    const parsed = JSON.parse(fsState.get(FILE)!) as Session;
    expect(parsed.messages).toHaveLength(3);
  });

  it('creates the target directory during load() so debounced writes succeed in fresh workspaces', async () => {
    // Track mkdir calls explicitly via the mocked module
    const fsModule = await import('node:fs');
    const mockedMkdir = fsModule.promises.mkdir as unknown as ReturnType<typeof vi.fn>;
    mockedMkdir.mockClear();

    const store = new SessionStore(FOLDER);
    await store.load();

    expect(mockedMkdir).toHaveBeenCalledWith('/fake/workspace/.vscode/agent-chat', { recursive: true });
  });
});
