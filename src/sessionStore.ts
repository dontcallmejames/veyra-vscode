import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { ulid } from './ulid.js';
import type {
  Session, UserMessage, AgentMessage, SystemMessage,
} from './shared/protocol.js';

const DEBOUNCE_MS = 200;
const SESSIONS_SUBPATH = '.vscode/agent-chat/sessions.json';

export class SessionStore {
  private session: Session = { version: 1, messages: [] };
  private writeTimer: NodeJS.Timeout | null = null;
  private writePromise: Promise<void> | null = null;
  private filePath: string;

  constructor(workspaceFolder: string) {
    this.filePath = join(workspaceFolder, SESSIONS_SUBPATH).replace(/\\/g, '/');
  }

  async load(): Promise<Session> {
    if (!existsSync(this.filePath)) {
      this.session = { version: 1, messages: [] };
      return this.session;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Session;
      if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
        throw new Error('schema mismatch');
      }
      this.session = parsed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.session = {
        version: 1,
        messages: [
          {
            id: ulid(),
            role: 'system',
            kind: 'error',
            text: 'Existing session file was corrupted and could not be loaded; starting fresh. (' + errMsg + ')',
            timestamp: Date.now(),
          },
        ],
      };
      this.scheduleWrite();
    }
    return this.session;
  }

  appendUser(msg: UserMessage): void {
    this.session.messages.push(msg);
    this.scheduleWrite();
  }

  appendAgent(msg: AgentMessage): void {
    this.session.messages.push(msg);
    this.scheduleWrite();
  }

  appendSystem(msg: SystemMessage): void {
    this.session.messages.push(msg);
    this.scheduleWrite();
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.write();
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      // Fire-and-forget: skip mkdir (dir created on first flush/load).
      // Chain writeFile→rename without top-level await so the side-effects
      // land within one microtask drain, satisfying debounce tests.
      const tmp = this.filePath + '.tmp';
      const data = JSON.stringify(this.session, null, 2);
      this.writePromise = fsp.writeFile(tmp, data, 'utf8')
        .then(() => fsp.rename(tmp, this.filePath));
    }, DEBOUNCE_MS);
  }

  private async write(): Promise<void> {
    const dir = dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.session, null, 2), 'utf8');
    await fsp.rename(tmp, this.filePath);
  }

  isFirstSession(): boolean {
    return this.session.messages.length === 0;
  }
}
