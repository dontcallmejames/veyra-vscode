import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseMentions } from './mentions.js';
import { ulid } from './ulid.js';
import { MessageRouter } from './messageRouter.js';
import { chooseFacilitatorAgent, type FacilitatorFn } from './facilitator.js';
import { SessionStore } from './sessionStore.js';
import { SentinelWriter } from './commitHook.js';
import { buildSharedContext } from './sharedContext.js';
import { buildEditAwareness, findPriorEditorsForFile, normalizeSessionFilePath } from './editAwareness.js';
import { readWorkspaceRules } from './workspaceRules.js';
import { parseFileMentions, embedFiles } from './fileMentions.js';
import { DEFAULT_AUTONOMY_POLICY, composePrompt } from './composePrompt.js';
import { parseWorkspaceContextMention, type WorkspaceContextProvider, type WorkspaceContextResult } from './workspaceContext.js';
import { formatProjectCommandHintsBlock, type ProjectCommandProvider } from './projectCommands.js';
import {
  type ChangeLedger,
  type ChangeLedgerBaseline,
  type ChangeSetDiffInputs,
  type DispatchChangeSet,
  type RejectChangeSetResult,
} from './changeLedger.js';
import {
  type Checkpoint,
  type CheckpointLedger,
  type RollbackPreviewFile,
} from './checkpointLedger.js';
import type { FileBadgesController } from './fileBadges.js';
import type { AgentRegistry } from './messageRouter.js';
import type {
  AgentMessage,
  CheckpointSummary,
  DispatchChangeSetSummary,
  FileChange,
  FileChangeKind,
  RollbackCheckpointPreview,
  RollbackCheckpointResult,
  Session,
  SystemMessage,
  ToolEvent,
  UserMessage,
} from './shared/protocol.js';
import type { AgentChunk, AgentId, AgentStatus } from './types.js';

export type VeyraDispatchSource = 'panel' | 'native-chat' | 'language-model';
export type VeyraForcedTarget = AgentId | 'veyra';

export interface VeyraDispatchRequest {
  text: string;
  workspaceContextQuery?: string;
  source: VeyraDispatchSource;
  cwd?: string;
  forcedTarget?: VeyraForcedTarget;
  readOnly?: boolean;
}

export type VeyraDispatchEvent =
  | { kind: 'user-message'; message: UserMessage }
  | { kind: 'system-message'; message: SystemMessage }
  | { kind: 'dispatch-start'; agentId: AgentId; messageId: string; timestamp: number }
  | { kind: 'chunk'; agentId: AgentId; messageId: string; chunk: AgentChunk }
  | { kind: 'dispatch-end'; agentId: AgentId; message: AgentMessage }
  | { kind: 'file-edited'; path: string; agentId: AgentId; timestamp: number; changeKind: FileChangeKind };

export type VeyraDispatchEventSink = (event: VeyraDispatchEvent) => void | Promise<void>;

export interface VeyraSessionOptions {
  watchdogMs?: number;
  hangSeconds?: number;
  fileEmbedMaxLines?: number;
  sharedContextWindow?: number;
  commitSignatureEnabled?: boolean;
  badgeController?: FileBadgesController;
  getEditedPathForAgent?: (agentId: AgentId, toolName: string, input: unknown) => string | null;
  workspaceChangeTracker?: WorkspaceChangeTracker;
  facilitator?: FacilitatorFn;
  workspaceContextProvider?: WorkspaceContextProvider;
  projectCommandProvider?: ProjectCommandProvider;
  changeLedger?: ChangeLedger;
  checkpointLedger?: CheckpointLedger;
}

export interface WorkspaceChangeTracker {
  snapshot(): Promise<unknown> | unknown;
  changedFilesSince(snapshot: unknown): Promise<string[]> | string[];
  changedFileChangesSince?(snapshot: unknown): Promise<FileChange[]> | FileChange[];
}

interface InProgressDispatch {
  id: string;
  text: string;
  toolEvents: ToolEvent[];
  editedFiles: string[];
  fileChanges: FileChange[];
  changeSnapshot?: unknown;
  changeBaseline?: ChangeLedgerBaseline;
  checkpointId?: string;
  agentId: AgentId;
  timestamp: number;
  readOnly?: boolean;
  error?: string;
  cancelled?: boolean;
}

const DEFAULT_HANG_SECONDS = 60;
const DEFAULT_FILE_EMBED_MAX_LINES = 500;
const DEFAULT_SHARED_CONTEXT_WINDOW = 25;
const READ_ONLY_WORKFLOW_POLICY = [
  '[Read-only workflow]',
  'Do not create, edit, rename, delete, or move files.',
  'Do not run commands that mutate the workspace, repository, dependencies, or user files.',
  'Provide analysis, findings, and recommendations only.',
  '[/Read-only workflow]',
].join('\n');

export function toRoutedInput(text: string, forcedTarget?: VeyraForcedTarget): string {
  if (!forcedTarget || forcedTarget === 'veyra') {
    return text;
  }

  const parsed = parseMentions(text);
  const promptText = parsed.targets.length > 0 ? parsed.remainingText : text.trim();
  return `@${forcedTarget} ${promptText}`.trim();
}

export class VeyraSessionService {
  private readonly router: MessageRouter;
  private readonly store: SessionStore;
  private sentinel: SentinelWriter;
  private currentDispatchInProgress: Map<AgentId, InProgressDispatch> | null = null;
  private hangSeconds: number;
  private fileEmbedMaxLines: number;
  private sharedContextWindow: number;
  private commitSignatureEnabled: boolean;
  private badgeController?: FileBadgesController;
  private getEditedPathForAgent?: (agentId: AgentId, toolName: string, input: unknown) => string | null;
  private workspaceChangeTracker?: WorkspaceChangeTracker;
  private workspaceContextProvider?: WorkspaceContextProvider;
  private projectCommandProvider?: ProjectCommandProvider;
  private changeLedger?: ChangeLedger;
  private checkpointLedger?: CheckpointLedger;
  private loadPromise: Promise<Session> | null = null;
  private dispatchQueue: Promise<void> = Promise.resolve();
  private cancelGeneration = 0;

  constructor(
    private readonly workspacePath: string,
    agents: AgentRegistry,
    options: VeyraSessionOptions = {},
  ) {
    this.router = new MessageRouter(
      agents,
      options.facilitator ?? chooseFacilitatorAgent,
      { watchdogMs: options.watchdogMs ?? 0 },
    );
    this.store = new SessionStore(workspacePath);
    this.hangSeconds = options.hangSeconds ?? DEFAULT_HANG_SECONDS;
    this.fileEmbedMaxLines = options.fileEmbedMaxLines ?? DEFAULT_FILE_EMBED_MAX_LINES;
    this.sharedContextWindow = options.sharedContextWindow ?? DEFAULT_SHARED_CONTEXT_WINDOW;
    this.commitSignatureEnabled = options.commitSignatureEnabled ?? true;
    this.badgeController = options.badgeController;
    this.getEditedPathForAgent = options.getEditedPathForAgent;
    this.workspaceChangeTracker = options.workspaceChangeTracker;
    this.workspaceContextProvider = options.workspaceContextProvider;
    this.projectCommandProvider = options.projectCommandProvider;
    this.changeLedger = options.changeLedger;
    this.checkpointLedger = options.checkpointLedger;
    this.sentinel = new SentinelWriter(workspacePath, {
      enabled: this.commitSignatureEnabled,
    });
  }

  loadSession(): Promise<Session> {
    this.loadPromise ??= this.store.load();
    return this.loadPromise;
  }

  onWriteError(listener: (err: unknown) => void): () => void {
    return this.store.onWriteError(listener);
  }

  onFloorChange(listener: (holder: AgentId | null) => void): () => void {
    return this.router.onFloorChange(listener);
  }

  onStatusChange(listener: (agentId: AgentId, status: AgentStatus) => void): () => void {
    return this.router.onStatusChange(listener);
  }

  notifyStatusChange(agentId: AgentId, status: AgentStatus): void {
    this.router.notifyStatusChange(agentId, status);
  }

  isFirstSession(): boolean {
    return this.store.isFirstSession();
  }

  updateOptions(options: Pick<
    VeyraSessionOptions,
    'hangSeconds' | 'fileEmbedMaxLines' | 'sharedContextWindow' | 'commitSignatureEnabled' | 'badgeController' | 'workspaceContextProvider' | 'projectCommandProvider' | 'changeLedger' | 'checkpointLedger'
  >): void {
    if (options.hangSeconds !== undefined) {
      this.hangSeconds = options.hangSeconds;
    }
    if (options.fileEmbedMaxLines !== undefined) {
      this.fileEmbedMaxLines = options.fileEmbedMaxLines;
    }
    if (options.sharedContextWindow !== undefined) {
      this.sharedContextWindow = options.sharedContextWindow;
    }
    if (
      options.commitSignatureEnabled !== undefined &&
      options.commitSignatureEnabled !== this.commitSignatureEnabled
    ) {
      this.commitSignatureEnabled = options.commitSignatureEnabled;
      this.sentinel = new SentinelWriter(this.workspacePath, {
        enabled: this.commitSignatureEnabled,
      });
    }
    if ('badgeController' in options) {
      this.badgeController = options.badgeController;
    }
    if ('workspaceContextProvider' in options) {
      this.workspaceContextProvider = options.workspaceContextProvider;
    }
    if ('projectCommandProvider' in options) {
      this.projectCommandProvider = options.projectCommandProvider;
    }
    if ('changeLedger' in options) {
      this.changeLedger = options.changeLedger;
    }
    if ('checkpointLedger' in options) {
      this.checkpointLedger = options.checkpointLedger;
    }
  }

  markCurrentDispatchCancelled(): void {
    if (!this.currentDispatchInProgress) return;
    for (const inProgress of this.currentDispatchInProgress.values()) {
      inProgress.cancelled = true;
    }
  }

  async cancelAll(): Promise<void> {
    this.cancelGeneration++;
    this.markCurrentDispatchCancelled();
    await this.router.cancelAll();
  }

  dispatch(request: VeyraDispatchRequest, emit: VeyraDispatchEventSink): Promise<void> {
    const generation = this.cancelGeneration;
    const queuedDispatch = this.dispatchQueue
      .catch(() => undefined)
      .then(() => {
        if (generation !== this.cancelGeneration) return undefined;
        return this.runDispatch(request, emit);
      });
    this.dispatchQueue = queuedDispatch.then(() => undefined, () => undefined);
    return queuedDispatch;
  }

  private async runDispatch(request: VeyraDispatchRequest, emit: VeyraDispatchEventSink): Promise<void> {
    if (request.readOnly) {
      const originalLength = this.store.snapshot().messages.length;
      try {
        return await this.store.withSuppressedWrites(() => this.runDispatchInner(request, emit));
      } finally {
        this.store.rollback(originalLength);
      }
    }
    return this.runDispatchInner(request, emit);
  }

  private async runDispatchInner(request: VeyraDispatchRequest, emit: VeyraDispatchEventSink): Promise<void> {
    void request.source;
    await this.loadSession();

    const workspaceContextSourceText = request.workspaceContextQuery ?? workspaceContextFallbackText(request);
    const workspaceContextMention = parseWorkspaceContextMention(workspaceContextSourceText);
    const textMention = workspaceContextMention.enabled
      ? parseWorkspaceContextMention(request.text)
      : { enabled: false, remainingText: request.text };
    const textWithoutWorkspaceContext = textMention.enabled
      ? textMention.remainingText
      : request.text;
    const { filePaths, remainingText } = parseFileMentions(textWithoutWorkspaceContext);
    const workspaceContextTextWithoutMention = workspaceContextMention.enabled
      ? workspaceContextMention.remainingText
      : workspaceContextSourceText;
    const workspaceContextTextWithoutFiles = parseFileMentions(workspaceContextTextWithoutMention).remainingText;
    const workspaceContextQuery = parseMentions(workspaceContextTextWithoutFiles).remainingText;
    const workspaceContextResult = await this.retrieveWorkspaceContext(
      workspaceContextMention.enabled,
      workspaceContextQuery,
    );
    const workspaceContextBlock = workspaceContextResult.block.trim().length > 0
      ? workspaceContextResult.block
      : formatWorkspaceContextDiagnosticsBlock(workspaceContextResult);
    const projectCommandBlock = await this.retrieveProjectCommandHints();
    const embedResult = embedFiles(filePaths, this.workspacePath, { maxLines: this.fileEmbedMaxLines });
    const userMentions = userMentionsForRequest(request.text, request.forcedTarget);
    const attachedFiles = dedupeAttachedFiles([
      ...workspaceContextResult.attached,
      ...embedResult.attached,
    ]);

    const userMsg: UserMessage = {
      id: ulid(),
      role: 'user',
      text: textWithoutWorkspaceContext,
      timestamp: Date.now(),
      ...(userMentions.length > 0 ? { mentions: userMentions } : {}),
      ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
    };
    this.store.appendUser(userMsg);
    await emit({ kind: 'user-message', message: userMsg });

    for (const diagnostic of workspaceContextResult.diagnostics) {
      const sys: SystemMessage = {
        id: ulid(),
        role: 'system',
        kind: 'error',
        text: `Workspace context (@codebase): ${diagnostic}`,
        timestamp: Date.now(),
      };
      this.store.appendSystem(sys);
      await emit({ kind: 'system-message', message: sys });
    }

    for (const e of embedResult.errors) {
      const sys: SystemMessage = {
        id: ulid(),
        role: 'system',
        kind: 'error',
        text: `${e.path}: ${e.reason}`,
        timestamp: Date.now(),
        filePath: e.path,
      };
      this.store.appendSystem(sys);
      await emit({ kind: 'system-message', message: sys });
    }

    const inProgressByAgent = new Map<AgentId, InProgressDispatch>();
    this.currentDispatchInProgress = inProgressByAgent;

    let lastChunkAt = Date.now();
    let activeAgentForHang: AgentId | null = null;
    const emitSystem = (sys: SystemMessage): void => {
      this.store.appendSystem(sys);
      void Promise.resolve(emit({ kind: 'system-message', message: sys }));
    };
    const hangCheckTimer = this.hangSeconds > 0 ? setInterval(() => {
      if (activeAgentForHang === null) return;
      if (Date.now() - lastChunkAt >= this.hangSeconds * 1000) {
        emitSystem({
          id: ulid(),
          role: 'system',
          kind: 'error',
          text: `${activeAgentForHang} hasn't responded for ${this.hangSeconds}s - keep waiting or cancel?`,
          timestamp: Date.now(),
        });
        lastChunkAt = Date.now();
      }
    }, 1000) : null;

    const composePromptForTarget = (_targetId: AgentId, baseText: string): string => {
      const session = this.store.snapshot();
      const sharedContext = buildSharedContext(session, { window: this.sharedContextWindow });
      const editAwareness = buildEditAwareness(session, _targetId);
      const rules = readWorkspaceRules(this.workspacePath);
      return [
        agentRolePreamble(_targetId),
        composePrompt({
        rules,
        autonomyPolicy: request.readOnly
          ? [READ_ONLY_WORKFLOW_POLICY, DEFAULT_AUTONOMY_POLICY].join('\n\n')
          : DEFAULT_AUTONOMY_POLICY,
        sharedContext,
        editAwareness,
        workspaceContext: workspaceContextBlock,
        projectCommands: projectCommandBlock,
        fileBlocks: embedResult.embedded,
        attachmentErrors: embedResult.errors,
        userText: baseText,
        }),
      ].join('\n\n');
    };

    const sharedContextForFacilitator = buildSharedContext(
      this.store.snapshot(),
      { window: this.sharedContextWindow },
    );

    try {
      for await (const event of this.router.handle(
        toRoutedInput(remainingText, request.forcedTarget),
        {
          cwd: request.cwd ?? this.workspacePath,
          readOnly: request.readOnly,
          composePromptForTarget,
          sharedContextForFacilitator,
        },
      )) {
        if (event.kind === 'facilitator-decision') {
          const sys: SystemMessage = {
            id: ulid(),
            role: 'system',
            kind: 'facilitator-decision',
            text: '',
            timestamp: Date.now(),
            agentId: event.agentId,
            reason: event.reason,
          };
          this.store.appendSystem(sys);
          await emit({ kind: 'system-message', message: sys });
          continue;
        }
        if (event.kind === 'routing-needed') {
          const sys: SystemMessage = {
            id: ulid(),
            role: 'system',
            kind: 'routing-needed',
            text: event.text,
            timestamp: Date.now(),
          };
          this.store.appendSystem(sys);
          await emit({ kind: 'system-message', message: sys });
          continue;
        }
        if (event.kind === 'dispatch-start') {
          if (!request.readOnly) {
            this.sentinel.dispatchStart(event.agentId);
          }
          const messageId = ulid();
          const timestamp = Date.now();
          let changeSnapshot: unknown;
          if (this.workspaceChangeTracker) {
            try {
              changeSnapshot = await this.workspaceChangeTracker.snapshot();
            } catch (err) {
              await this.emitWorkspaceChangeError(
                event.agentId,
                `Unable to snapshot workspace changes before ${agentLabel(event.agentId)} dispatch: ${errorMessage(err)}`,
                emit,
              );
            }
          }
          let changeBaseline: ChangeLedgerBaseline | undefined;
          if (this.changeLedger) {
            try {
              changeBaseline = await this.changeLedger.captureBaseline(messageId);
            } catch (err) {
              await this.emitWorkspaceChangeError(
                event.agentId,
                `Unable to capture diff preview baseline before ${agentLabel(event.agentId)} dispatch: ${errorMessage(err)}`,
                emit,
              );
            }
          }
          let checkpointId: string | undefined;
          if (!request.readOnly && this.checkpointLedger) {
            try {
              const checkpoint = await this.checkpointLedger.createCheckpoint({
                source: 'automatic',
                label: `Before ${agentLabel(event.agentId)} dispatch`,
                promptSummary: summarizePrompt(request.text),
                agentId: event.agentId,
                messageId,
                timestamp,
              });
              checkpointId = checkpoint.id;
            } catch (err) {
              await this.emitWorkspaceChangeError(
                event.agentId,
                `Unable to create checkpoint before ${agentLabel(event.agentId)} dispatch: ${errorMessage(err)}`,
                emit,
              );
            }
          }
          inProgressByAgent.set(event.agentId, {
            id: messageId,
            text: '',
            toolEvents: [],
            editedFiles: [],
            fileChanges: [],
            changeSnapshot,
            changeBaseline,
            checkpointId,
            agentId: event.agentId,
            timestamp,
            readOnly: request.readOnly,
          });
          await emit({ kind: 'dispatch-start', agentId: event.agentId, messageId, timestamp });
          activeAgentForHang = event.agentId;
          lastChunkAt = Date.now();
          continue;
        }
        if (event.kind === 'chunk') {
          const inProgress = inProgressByAgent.get(event.agentId);
          if (!inProgress) continue;
          if (event.chunk.type === 'text') {
            inProgress.text += event.chunk.text;
          } else if (event.chunk.type === 'tool-call') {
            inProgress.toolEvents.push({
              kind: 'call',
              name: event.chunk.name,
              input: event.chunk.input,
              timestamp: Date.now(),
            });
          } else if (event.chunk.type === 'tool-result') {
            const chunk = event.chunk;
            inProgress.toolEvents.push({
              kind: 'result',
              name: chunk.name,
              output: chunk.output,
              timestamp: Date.now(),
            });
            const matchingCall = [...inProgress.toolEvents].reverse().find(
              (e) => e.kind === 'call' && e.name === chunk.name,
            ) as { input: unknown } | undefined;
            if (matchingCall && this.getEditedPathForAgent) {
              const editedPath = this.getEditedPathForAgent(event.agentId, chunk.name, matchingCall.input);
              if (editedPath) {
                await this.recordEditedFile(
                  inProgress,
                  event.agentId,
                  editedPath,
                  inferToolResultChangeKind(chunk.output),
                  emit,
                );
              }
            }
          } else if (event.chunk.type === 'error') {
            inProgress.error = event.chunk.message;
          }
          lastChunkAt = Date.now();
          await emit({
            kind: 'chunk',
            agentId: event.agentId,
            messageId: inProgress.id,
            chunk: event.chunk,
          });
          continue;
        }
        if (event.kind === 'dispatch-end') {
          const inProgress = inProgressByAgent.get(event.agentId);
          if (!inProgress) continue;
          await this.recordWorkspaceChanges(inProgress, event.agentId, emit);
          await this.emitCheckpointNoticeIfNeeded(inProgress, event.agentId, emit);
          await this.emitChangeSetNoticeIfNeeded(inProgress, event.agentId, emit);
          const status: AgentMessage['status'] =
            inProgress.cancelled ? 'cancelled' : (inProgress.error ? 'errored' : 'complete');
          const finalized: AgentMessage = {
            id: inProgress.id,
            role: 'agent',
            agentId: inProgress.agentId,
            text: inProgress.text,
            toolEvents: inProgress.toolEvents,
            ...(inProgress.editedFiles.length > 0 ? { editedFiles: inProgress.editedFiles } : {}),
            ...(inProgress.fileChanges.length > 0 ? { fileChanges: inProgress.fileChanges } : {}),
            timestamp: inProgress.timestamp,
            status,
            ...(inProgress.error ? { error: inProgress.error } : {}),
          };
          this.store.appendAgent(finalized);
          await emit({ kind: 'dispatch-end', agentId: event.agentId, message: finalized });
          inProgressByAgent.delete(event.agentId);
          activeAgentForHang = null;
          if (!request.readOnly) {
            this.sentinel.dispatchEnd(event.agentId);
          }
        }
      }
    } finally {
      if (hangCheckTimer) clearInterval(hangCheckTimer);
      for (const inProgress of inProgressByAgent.values()) {
        if (!request.readOnly) {
          this.sentinel.dispatchEnd(inProgress.agentId);
        }
      }
      this.currentDispatchInProgress = null;
    }
  }

  invalidateWorkspaceContext(): void {
    this.workspaceContextProvider?.invalidate();
    this.projectCommandProvider?.invalidate();
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  async listPendingChangeSets(): Promise<DispatchChangeSetSummary[]> {
    if (!this.changeLedger) return [];
    return (await this.changeLedger.listPendingChangeSets()).map(changeSetSummary);
  }

  async getChangeSet(id: string): Promise<DispatchChangeSetSummary | null> {
    if (!this.changeLedger) return null;
    const changeSet = await this.changeLedger.getChangeSet(id);
    return changeSet ? changeSetSummary(changeSet) : null;
  }

  async acceptChangeSet(id: string): Promise<DispatchChangeSetSummary> {
    if (!this.changeLedger) throw new Error('Diff preview is unavailable.');
    return changeSetSummary(await this.changeLedger.acceptChangeSet(id));
  }

  async rejectChangeSet(id: string): Promise<RejectChangeSetResult> {
    if (!this.changeLedger) throw new Error('Diff preview is unavailable.');
    return this.changeLedger.rejectChangeSet(id);
  }

  async changeSetDiffInputs(id: string, filePath: string): Promise<ChangeSetDiffInputs> {
    if (!this.changeLedger) throw new Error('Diff preview is unavailable.');
    return this.changeLedger.diffInputs(id, filePath);
  }

  async createManualCheckpoint(label?: string): Promise<CheckpointSummary> {
    if (!this.checkpointLedger) throw new Error('Checkpoints are unavailable.');
    const trimmed = label?.trim();
    return checkpointSummary(await this.checkpointLedger.createCheckpoint({
      source: 'manual',
      label: trimmed && trimmed.length > 0 ? trimmed : 'Manual checkpoint',
      promptSummary: 'manual checkpoint',
      timestamp: Date.now(),
    }));
  }

  async listCheckpoints(): Promise<CheckpointSummary[]> {
    if (!this.checkpointLedger) return [];
    return (await this.checkpointLedger.listCheckpoints()).map(checkpointSummary);
  }

  async previewLatestCheckpointRollback(): Promise<RollbackCheckpointPreview | null> {
    if (!this.checkpointLedger) return null;
    const preview = await this.checkpointLedger.previewLatestRollback();
    return preview ? {
      ...preview,
      files: preview.files.map(checkpointFileChange),
    } : null;
  }

  async rollbackLatestCheckpoint(): Promise<RollbackCheckpointResult> {
    if (!this.checkpointLedger) throw new Error('Checkpoints are unavailable.');
    return this.checkpointLedger.rollbackLatestCheckpoint();
  }

  private async retrieveWorkspaceContext(
    enabled: boolean,
    query: string,
  ): Promise<WorkspaceContextResult> {
    if (!enabled) {
      return emptyWorkspaceContextResult(false, query, []);
    }
    if (!this.workspaceContextProvider) {
      return emptyWorkspaceContextResult(true, query, ['Workspace context provider is unavailable.']);
    }

    try {
      return await this.workspaceContextProvider.retrieve(query);
    } catch (err) {
      return emptyWorkspaceContextResult(true, query, [`Unable to retrieve workspace context: ${errorMessage(err)}`]);
    }
  }

  private async retrieveProjectCommandHints(): Promise<string> {
    if (!this.projectCommandProvider) return '';
    try {
      return formatProjectCommandHintsBlock(await this.projectCommandProvider.retrieve());
    } catch {
      return '';
    }
  }

  private async recordWorkspaceChanges(
    inProgress: InProgressDispatch,
    agentId: AgentId,
    emit: VeyraDispatchEventSink,
  ): Promise<void> {
    if (!this.workspaceChangeTracker || inProgress.changeSnapshot === undefined) return;
    try {
      if (this.workspaceChangeTracker.changedFileChangesSince) {
        const changes = await this.workspaceChangeTracker.changedFileChangesSince(inProgress.changeSnapshot);
        for (const change of changes) {
          await this.recordEditedFile(
            inProgress,
            agentId,
            change.path,
            change.changeKind,
            emit,
          );
        }
        return;
      }

      const changedFiles = await this.workspaceChangeTracker.changedFilesSince(inProgress.changeSnapshot);
      for (const filePath of changedFiles) {
        await this.recordEditedFile(
          inProgress,
          agentId,
          filePath,
          detectFileChangeKind(this.workspacePath, filePath),
          emit,
        );
      }
    } catch (err) {
      await this.emitWorkspaceChangeError(
        agentId,
        `Unable to detect workspace changes after ${agentLabel(agentId)} dispatch: ${errorMessage(err)}`,
        emit,
      );
      return;
    }
  }

  private async emitWorkspaceChangeError(
    agentId: AgentId,
    text: string,
    emit: VeyraDispatchEventSink,
  ): Promise<void> {
    const sys: SystemMessage = {
      id: ulid(),
      role: 'system',
      kind: 'error',
      text,
      timestamp: Date.now(),
      agentId,
    };
    this.store.appendSystem(sys);
    await emit({ kind: 'system-message', message: sys });
  }

  private async emitCheckpointNoticeIfNeeded(
    inProgress: InProgressDispatch,
    agentId: AgentId,
    emit: VeyraDispatchEventSink,
  ): Promise<void> {
    if (!this.checkpointLedger || !inProgress.checkpointId) return;

    let checkpoint: Checkpoint;
    try {
      checkpoint = await this.checkpointLedger.finalizeAutomaticCheckpoint(
        inProgress.checkpointId,
        inProgress.fileChanges,
      );
    } catch (err) {
      await this.emitWorkspaceChangeError(
        agentId,
        `Unable to finalize checkpoint after ${agentLabel(agentId)} dispatch: ${errorMessage(err)}`,
        emit,
      );
      return;
    }

    const summary = checkpointSummary(checkpoint);
    const sys: SystemMessage = {
      id: ulid(),
      role: 'system',
      kind: 'checkpoint',
      text: `Checkpoint saved: ${checkpoint.label}.`,
      timestamp: Date.now(),
      agentId,
      checkpoint: summary,
    };
    this.store.appendSystem(sys);
    await emit({ kind: 'system-message', message: sys });
  }

  private async emitChangeSetNoticeIfNeeded(
    inProgress: InProgressDispatch,
    agentId: AgentId,
    emit: VeyraDispatchEventSink,
  ): Promise<void> {
    if (!this.changeLedger || !inProgress.changeBaseline || inProgress.fileChanges.length === 0) return;

    let changeSet: DispatchChangeSet | null;
    try {
      changeSet = await this.changeLedger.createChangeSet(inProgress.changeBaseline, {
        agentId,
        messageId: inProgress.id,
        readOnly: inProgress.readOnly === true,
        files: inProgress.fileChanges,
        timestamp: Date.now(),
      });
    } catch (err) {
      await this.emitWorkspaceChangeError(
        agentId,
        `Unable to create diff preview change set for ${agentLabel(agentId)} dispatch: ${errorMessage(err)}`,
        emit,
      );
      return;
    }

    if (!changeSet) return;

    const summary = changeSetSummary(changeSet);
    const count = summary.fileCount;
    const fileLabel = count === 1 ? 'file' : 'files';
    const text = summary.readOnly
      ? `${agentLabel(agentId)} changed ${count} ${fileLabel} during a read-only workflow. Review or reject these changes before continuing.`
      : `${agentLabel(agentId)} changed ${count} ${fileLabel}. Review pending changes before continuing.`;
    const sys: SystemMessage = {
      id: ulid(),
      role: 'system',
      kind: 'change-set',
      text,
      timestamp: Date.now(),
      agentId,
      changeSet: summary,
    };
    this.store.appendSystem(sys);
    await emit({ kind: 'system-message', message: sys });
  }

  private async recordEditedFile(
    inProgress: InProgressDispatch,
    agentId: AgentId,
    filePath: string,
    changeKind: FileChangeKind,
    emit: VeyraDispatchEventSink,
  ): Promise<void> {
    const normalizedPath = normalizeEditedPath(this.workspacePath, filePath);
    if (!inProgress.editedFiles.includes(normalizedPath)) {
      inProgress.editedFiles.push(normalizedPath);
      inProgress.fileChanges.push({ path: normalizedPath, changeKind });
    } else {
      const existingChange = inProgress.fileChanges.find((change) => change.path === normalizedPath);
      const resolvedKind = resolveChangeKind(existingChange?.changeKind ?? 'edited', changeKind);
      if (!existingChange || existingChange.changeKind === resolvedKind) return;
      existingChange.changeKind = resolvedKind;
      await this.emitReadOnlyViolationIfNeeded(inProgress, agentId, normalizedPath, resolvedKind, emit);
      await this.emitEditConflictIfNeeded(agentId, normalizedPath, resolvedKind, emit);
      this.badgeController?.registerEdit(normalizedPath, agentId, resolvedKind);
      await emit({
        kind: 'file-edited',
        path: normalizedPath,
        agentId,
        changeKind: resolvedKind,
        timestamp: Date.now(),
      });
      return;
    }

    await this.emitReadOnlyViolationIfNeeded(inProgress, agentId, normalizedPath, changeKind, emit);
    await this.emitEditConflictIfNeeded(agentId, normalizedPath, changeKind, emit);
    this.badgeController?.registerEdit(normalizedPath, agentId, changeKind);
    await emit({
      kind: 'file-edited',
      path: normalizedPath,
      agentId,
      changeKind,
      timestamp: Date.now(),
    });
  }

  private async emitReadOnlyViolationIfNeeded(
    inProgress: InProgressDispatch,
    agentId: AgentId,
    filePath: string,
    changeKind: FileChangeKind,
    emit: VeyraDispatchEventSink,
  ): Promise<void> {
    if (!inProgress.readOnly) return;

    const sys: SystemMessage = {
      id: ulid(),
      role: 'system',
      kind: 'error',
      text: `Read-only workflow violation: ${agentLabel(agentId)} ${fileChangeVerb(changeKind)} ${filePath} during a read-only dispatch.`,
      timestamp: Date.now(),
      agentId,
      filePath,
      changeKind,
    };
    this.store.appendSystem(sys);
    await emit({ kind: 'system-message', message: sys });
  }

  private async emitEditConflictIfNeeded(
    agentId: AgentId,
    filePath: string,
    changeKind: FileChangeKind,
    emit: VeyraDispatchEventSink,
  ): Promise<void> {
    const priorEditors = findPriorEditorsForFile(this.store.snapshot(), agentId, filePath);
    if (priorEditors.length === 0) return;

    const sys: SystemMessage = {
      id: ulid(),
      role: 'system',
      kind: 'edit-conflict',
      text: `${agentLabel(agentId)} ${fileChangeVerb(changeKind)} ${filePath}, which was already edited by ${formatAgentList(priorEditors)} in this session.`,
      timestamp: Date.now(),
      agentId,
      filePath,
      changeKind,
    };
    this.store.appendSystem(sys);
    await emit({ kind: 'system-message', message: sys });
  }
}

function agentLabel(agentId: AgentId): string {
  if (agentId === 'claude') return 'Claude';
  if (agentId === 'codex') return 'Codex';
  return 'Gemini';
}

function agentRolePreamble(agentId: AgentId): string {
  const label = agentLabel(agentId);
  const strengths: Record<AgentId, string> = {
    claude: 'architecture, requirements fit, and long-term correctness',
    codex: 'concrete implementation, tests, and regression risk',
    gemini: 'edge cases, alternate interpretations, and adversarial review',
  };
  return [
    '[Veyra agent role]',
    `You are ${label} in this Veyra dispatch.`,
    `Use your strengths: ${strengths[agentId]}.`,
    'Use your available model and CLI capabilities that fit this workflow.',
    'Follow any read-only or edit-permitted instructions in this prompt.',
    'Respect prior agents in [Conversation so far] and coordinate without overwriting their work.',
    '[/Veyra agent role]',
  ].join('\n');
}

function formatAgentList(agentIds: AgentId[]): string {
  return agentIds.map(agentLabel).join(', ');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function summarizePrompt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function emptyWorkspaceContextResult(
  enabled: boolean,
  query: string,
  diagnostics: string[],
): WorkspaceContextResult {
  return {
    enabled,
    query,
    block: '',
    attached: [],
    selected: [],
    diagnostics,
  };
}

function workspaceContextFallbackText(request: VeyraDispatchRequest): string {
  return request.source === 'panel' ? request.text : '';
}

function formatWorkspaceContextDiagnosticsBlock(result: WorkspaceContextResult): string {
  if (!result.enabled || result.diagnostics.length === 0) return '';
  return [
    '[Workspace context from @codebase]',
    'Diagnostics:',
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`),
    '[/Workspace context]',
  ].join('\n');
}

function dedupeAttachedFiles(
  files: NonNullable<UserMessage['attachedFiles']>,
): NonNullable<UserMessage['attachedFiles']> {
  const seen = new Set<string>();
  const deduped: NonNullable<UserMessage['attachedFiles']> = [];
  for (const file of files) {
    const normalized = normalizeSessionFilePath(file.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(file);
  }
  return deduped;
}

function fileChangeVerb(changeKind: FileChangeKind): string {
  if (changeKind === 'created') return 'created';
  return changeKind === 'deleted' ? 'deleted' : 'edited';
}

function resolveChangeKind(existing: FileChangeKind, next: FileChangeKind): FileChangeKind {
  if (existing === next) return existing;
  if (existing === 'edited') return next;
  if (next === 'edited') return existing;
  return next;
}

function inferToolResultChangeKind(output: unknown): FileChangeKind {
  if (typeof output !== 'object' || output === null) return 'edited';
  const record = output as Record<string, unknown>;
  const rawKind = typeof record.kind === 'string'
    ? record.kind
    : typeof record.changeKind === 'string'
      ? record.changeKind
      : '';
  const normalized = rawKind.toLowerCase();
  if (normalized === 'add' || normalized === 'added' || normalized === 'create' || normalized === 'created') {
    return 'created';
  }
  return normalized === 'delete' || normalized === 'deleted' || normalized === 'remove' || normalized === 'removed'
    ? 'deleted'
    : 'edited';
}

function userMentionsForRequest(text: string, forcedTarget?: VeyraForcedTarget): AgentId[] {
  if (forcedTarget && forcedTarget !== 'veyra') {
    return [forcedTarget];
  }
  return parseMentions(text).targets;
}

function normalizeEditedPath(workspacePath: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return normalizeSessionFilePath(filePath);
  }

  const relative = path.relative(workspacePath, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return normalizeSessionFilePath(relative);
  }
  return normalizeSessionFilePath(filePath);
}

function detectFileChangeKind(workspacePath: string, filePath: string): FileChangeKind {
  const workspaceRoot = path.resolve(workspacePath);
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);

  if (path.isAbsolute(filePath)) {
    const relative = path.relative(workspaceRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return 'edited';
    }
  }

  return fs.existsSync(absolutePath) ? 'edited' : 'deleted';
}

function changeSetSummary(changeSet: DispatchChangeSet): DispatchChangeSetSummary {
  const files = changeSet.files.map((file) => ({
    path: file.path,
    changeKind: file.changeKind,
  }));
  return {
    id: changeSet.id,
    agentId: changeSet.agentId,
    messageId: changeSet.messageId,
    timestamp: changeSet.timestamp,
    readOnly: changeSet.readOnly,
    status: changeSet.status,
    fileCount: changeSet.fileCount ?? files.length,
    files,
  };
}

function checkpointSummary(checkpoint: Checkpoint): CheckpointSummary {
  return {
    id: checkpoint.id,
    timestamp: checkpoint.timestamp,
    source: checkpoint.source,
    label: checkpoint.label,
    promptSummary: checkpoint.promptSummary,
    status: checkpoint.status,
    fileCount: checkpoint.fileCount,
    ...(checkpoint.agentId ? { agentId: checkpoint.agentId } : {}),
    ...(checkpoint.messageId ? { messageId: checkpoint.messageId } : {}),
    ...(checkpoint.workflow ? { workflow: checkpoint.workflow } : {}),
  };
}

function checkpointFileChange(file: RollbackPreviewFile): FileChange {
  return {
    path: file.path,
    changeKind: file.changeKind,
  };
}
