import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentId } from './types.js';

const SENTINEL_DIR_REL = path.join('.vscode', 'agent-chat');
const SENTINEL_NAME = 'active-dispatch';

export interface SentinelWriterOptions {
  enabled?: boolean;
}

export class SentinelWriter {
  private active = new Set<AgentId>();
  private latest: AgentId | null = null;
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly file: string;

  constructor(workspacePath: string, options: SentinelWriterOptions = {}) {
    this.enabled = options.enabled !== false;
    this.dir = path.join(workspacePath, SENTINEL_DIR_REL).replace(/\\/g, '/');
    this.file = path.join(this.dir, SENTINEL_NAME).replace(/\\/g, '/');
  }

  dispatchStart(agentId: AgentId): void {
    if (!this.enabled) return;
    this.active.add(agentId);
    this.latest = agentId;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, `${agentId}\n`);
    } catch {
      // best-effort
    }
  }

  dispatchEnd(agentId: AgentId): void {
    if (!this.enabled) return;
    this.active.delete(agentId);
    if (this.active.size === 0) {
      this.latest = null;
      try {
        if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      } catch {
        // best-effort
      }
    } else {
      const remaining = this.active.values().next().value;
      if (remaining) {
        this.latest = remaining;
        try {
          fs.writeFileSync(this.file, `${remaining}\n`);
        } catch {
          // best-effort
        }
      }
    }
  }
}
