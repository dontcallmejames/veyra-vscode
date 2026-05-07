import type {
  Session, InProgressMessage, FromExtension, Settings,
} from '../shared/protocol.js';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import type { AgentId, AgentStatus } from '../types.js';

export type WebviewState = {
  session: Session;
  inProgress: Map<string, InProgressMessage>;
  status: Record<AgentId, AgentStatus>;
  settings: Settings;
  floorHolder: AgentId | null;
  gambitMdPresent: boolean;
};

export function initialState(): WebviewState {
  return {
    session: { version: 1, messages: [] },
    inProgress: new Map(),
    status: { claude: 'ready', codex: 'ready', gemini: 'ready' },
    settings: DEFAULT_SETTINGS,
    floorHolder: null,
    gambitMdPresent: false,
  };
}

export function reduce(state: WebviewState, event: FromExtension): WebviewState {
  switch (event.kind) {
    case 'init':
      return {
        ...state,
        session: event.session,
        status: event.status,
        settings: event.settings,
        gambitMdPresent: event.gambitMdPresent,
      };

    case 'gambit-md-changed':
      return { ...state, gambitMdPresent: event.present };

    case 'message-started': {
      const next = new Map(state.inProgress);
      next.set(event.id, {
        id: event.id,
        role: 'agent',
        agentId: event.agentId,
        text: '',
        toolEvents: [],
        timestamp: event.timestamp,
      });
      return { ...state, inProgress: next };
    }

    case 'message-chunk': {
      const existing = state.inProgress.get(event.id);
      if (!existing) return state;
      const updated = applyChunk(existing, event.chunk);
      if (updated === existing) return state;
      const next = new Map(state.inProgress);
      next.set(event.id, updated);
      return { ...state, inProgress: next };
    }

    case 'message-finalized': {
      const next = new Map(state.inProgress);
      next.delete(event.message.id);
      return {
        ...state,
        inProgress: next,
        session: {
          ...state.session,
          messages: [...state.session.messages, event.message],
        },
      };
    }

    case 'system-message':
      return {
        ...state,
        session: {
          ...state.session,
          messages: [...state.session.messages, event.message],
        },
      };

    case 'floor-changed':
      return { ...state, floorHolder: event.holder };

    case 'status-changed':
      return {
        ...state,
        status: { ...state.status, [event.agentId]: event.status },
      };

    case 'settings-changed':
      return { ...state, settings: event.settings };

    case 'user-message-appended':
      return {
        ...state,
        session: {
          ...state.session,
          messages: [...state.session.messages, event.message],
        },
      };

    case 'file-edited':
      return state;
  }
}

function applyChunk(msg: InProgressMessage, chunk: import('../types.js').AgentChunk): InProgressMessage {
  switch (chunk.type) {
    case 'text':
      return { ...msg, text: msg.text + chunk.text };
    case 'tool-call':
      return {
        ...msg,
        toolEvents: [...msg.toolEvents, { kind: 'call', name: chunk.name, input: chunk.input, timestamp: Date.now() }],
      };
    case 'tool-result':
      return {
        ...msg,
        toolEvents: [...msg.toolEvents, { kind: 'result', name: chunk.name, output: chunk.output, timestamp: Date.now() }],
      };
    case 'error':
    case 'done':
      return msg;
  }
}
