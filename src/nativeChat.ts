import * as path from 'node:path';
import * as vscode from 'vscode';
import type { VeyraDispatchEvent, VeyraForcedTarget, VeyraSessionService } from './veyraService.js';
import type { AgentId } from './types.js';
import { veyraWorkflowPrompt, type VeyraWorkflowCommand } from './workflowPrompts.js';
import { parseWorkspaceContextMention } from './workspaceContext.js';

export interface NativeChatRegistration {
  service: VeyraSessionService;
  workspacePath: string;
}

export interface ParticipantDefinition {
  id: string;
  name: string;
  fullName: string;
  description: string;
  forcedTarget: VeyraForcedTarget;
}

export const NATIVE_CHAT_PARTICIPANTS: ParticipantDefinition[] = [
  {
    id: 'veyra.veyra',
    name: 'veyra',
    fullName: 'Veyra',
    description: 'Route work across Claude, Codex, and Gemini.',
    forcedTarget: 'veyra',
  },
  {
    id: 'veyra.claude',
    name: 'claude',
    fullName: 'Claude',
    description: 'Send this request directly to Claude through Veyra.',
    forcedTarget: 'claude',
  },
  {
    id: 'veyra.codex',
    name: 'codex',
    fullName: 'Codex',
    description: 'Send this request directly to Codex through Veyra.',
    forcedTarget: 'codex',
  },
  {
    id: 'veyra.gemini',
    name: 'gemini',
    fullName: 'Gemini',
    description: 'Send this request directly to Gemini through Veyra.',
    forcedTarget: 'gemini',
  },
];

export interface NativeChatRoutedPrompt {
  text: string;
  forcedTarget: VeyraForcedTarget;
  readOnly?: boolean;
  workspaceContextQuery?: string;
}

interface NativeChatReferencePrompt {
  readonly prompt: string;
  readonly references?: readonly vscode.ChatPromptReference[];
  readonly toolReferences?: readonly vscode.ChatLanguageModelToolReference[];
}

export function nativeChatPromptForRequest(
  definition: ParticipantDefinition,
  request: vscode.ChatRequest,
  workspacePath?: string,
  chatContext?: vscode.ChatContext,
): NativeChatRoutedPrompt {
  const currentPrompt = promptWithChatReferences(request, workspacePath);
  const workspaceContextQuery = hasCodebaseMention(currentPrompt) ? currentPrompt : undefined;
  const prompt = withNativeChatHistory(
    currentPrompt,
    chatContext,
    workspacePath,
  );

  if (definition.forcedTarget !== 'veyra') {
    return withWorkspaceContextQuery({
      text: prompt,
      forcedTarget: definition.forcedTarget,
    }, workspaceContextQuery);
  }

  if (request.command === 'review') {
    if (!prompt.trim()) {
      return {
        forcedTarget: 'veyra',
        text: '',
        readOnly: true,
      };
    }
    return withWorkspaceContextQuery({
      forcedTarget: 'veyra',
      text: veyraWorkflowPrompt('review', prompt),
      readOnly: true,
    }, workspaceContextQuery);
  }

  if (request.command === 'debate') {
    if (!prompt.trim()) {
      return {
        forcedTarget: 'veyra',
        text: '',
        readOnly: true,
      };
    }
    return withWorkspaceContextQuery({
      forcedTarget: 'veyra',
      text: veyraWorkflowPrompt('debate', prompt),
      readOnly: true,
    }, workspaceContextQuery);
  }

  if (request.command === 'implement') {
    if (!prompt.trim()) {
      return {
        forcedTarget: 'veyra',
        text: '',
      };
    }
    return withWorkspaceContextQuery({
      forcedTarget: 'veyra',
      text: veyraWorkflowPrompt('implement', prompt),
    }, workspaceContextQuery);
  }

  return withWorkspaceContextQuery({
    text: prompt,
    forcedTarget: definition.forcedTarget,
  }, workspaceContextQuery);
}

export function registerNativeChatParticipants(
  context: vscode.ExtensionContext,
  getRegistration: () => NativeChatRegistration | undefined,
): string[] {
  const registeredIds: string[] = [];
  for (const definition of NATIVE_CHAT_PARTICIPANTS) {
    const participant = vscode.chat.createChatParticipant(
      definition.id,
      async (request, chatContext, response, token) => {
        const registration = getRegistration();
        if (!registration) {
          response.markdown('Open a workspace folder before using Veyra chat participants.');
          return {
            errorDetails: { message: 'Veyra requires an open workspace folder.' },
            metadata: { participant: definition.name },
          };
        }

        return handleNativeChatRequest(definition, registration, request, chatContext, response, token);
      },
    );
    participant.iconPath = new vscode.ThemeIcon('comment-discussion');
    context.subscriptions.push(participant);
    registeredIds.push(definition.id);
  }
  return registeredIds;
}

export function nativeChatWorkflowDiagnostics(): Record<VeyraWorkflowCommand, {
  forcedTarget: VeyraForcedTarget;
  readOnly: boolean;
  containsAllMention: boolean;
  containsWorkflowMarker: boolean;
}> {
  const veyra = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.forcedTarget === 'veyra')!;
  return Object.fromEntries((['review', 'debate', 'implement'] as VeyraWorkflowCommand[]).map((command) => {
    const routed = nativeChatPromptForRequest(
      veyra,
      {
        command,
        prompt: `Smoke diagnostic for ${command}.`,
      } as vscode.ChatRequest,
    );
    return [
      command,
      {
        forcedTarget: routed.forcedTarget,
        readOnly: routed.readOnly === true,
        containsAllMention: routed.text.includes('@all'),
        containsWorkflowMarker: routed.text.includes(`Workflow: ${command}`),
      },
    ];
  })) as Record<VeyraWorkflowCommand, {
    forcedTarget: VeyraForcedTarget;
    readOnly: boolean;
    containsAllMention: boolean;
    containsWorkflowMarker: boolean;
  }>;
}

export async function nativeChatSmokeResponses(registration: NativeChatRegistration): Promise<Record<string, string>> {
  const requests: Array<{
    key: string;
    participantId: string;
    command?: VeyraWorkflowCommand;
    prompt: string;
  }> = [
    {
      key: 'veyra.veyra',
      participantId: 'veyra.veyra',
      prompt: 'Veyra native chat smoke request.',
    },
    {
      key: 'veyra.veyra/codebase',
      participantId: 'veyra.veyra',
      prompt: '@codebase Veyra native chat codebase smoke request. [veyra-smoke-codebase]',
    },
    {
      key: 'veyra.veyra/review',
      participantId: 'veyra.veyra',
      command: 'review',
      prompt: 'Veyra native chat review smoke request.',
    },
    {
      key: 'veyra.veyra/debate',
      participantId: 'veyra.veyra',
      command: 'debate',
      prompt: 'Veyra native chat debate smoke request.',
    },
    {
      key: 'veyra.veyra/implement',
      participantId: 'veyra.veyra',
      command: 'implement',
      prompt: 'Veyra native chat implement smoke request.',
    },
    {
      key: 'veyra.veyra/conflict',
      participantId: 'veyra.veyra',
      command: 'implement',
      prompt: 'Veyra native chat edit conflict smoke request. [veyra-smoke-conflict]',
    },
    {
      key: 'veyra.veyra/shared-context',
      participantId: 'veyra.veyra',
      command: 'implement',
      prompt: 'Veyra native chat shared context smoke request. [veyra-smoke-shared-context]',
    },
    {
      key: 'veyra.claude',
      participantId: 'veyra.claude',
      prompt: 'Veyra native chat Claude smoke request.',
    },
    {
      key: 'veyra.codex',
      participantId: 'veyra.codex',
      prompt: 'Veyra native chat Codex smoke request.',
    },
    {
      key: 'veyra.gemini',
      participantId: 'veyra.gemini',
      prompt: 'Veyra native chat Gemini smoke request.',
    },
  ];
  const responses: Record<string, string> = {};
  for (const request of requests) {
    const definition = NATIVE_CHAT_PARTICIPANTS.find((participant) => participant.id === request.participantId);
    if (!definition) continue;
    const cts = new vscode.CancellationTokenSource();
    try {
      const collector = createNativeChatSmokeResponseCollector();
      await handleNativeChatRequest(
        definition,
        registration,
        {
          prompt: request.prompt,
          command: request.command,
          references: [],
          toolReferences: [],
        } as unknown as vscode.ChatRequest,
        { history: [] } as unknown as vscode.ChatContext,
        collector.response,
        cts.token,
      );
      responses[request.key] = collector.text();
    } finally {
      cts.dispose();
    }
  }
  return responses;
}

async function handleNativeChatRequest(
  definition: ParticipantDefinition,
  registration: NativeChatRegistration,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  response: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  let sawText = false;
  let sawError = false;
  if (token.isCancellationRequested) {
    return {
      metadata: {
        participant: definition.name,
        forcedTarget: definition.forcedTarget,
      },
    };
  }

  const cancellation = token.onCancellationRequested(() => {
    void registration.service.cancelAll();
  });

  try {
    const routedPrompt = nativeChatPromptForRequest(definition, request, registration.workspacePath, chatContext);
    if (!routedPrompt.text.trim()) {
      response.markdown('Provide a prompt before using Veyra chat participants.');
      return {
        metadata: {
          participant: definition.name,
          forcedTarget: definition.forcedTarget,
        },
      };
    }
    await registration.service.dispatch(
      {
        text: routedPrompt.text,
        source: 'native-chat',
        cwd: registration.workspacePath,
        forcedTarget: routedPrompt.forcedTarget,
        readOnly: routedPrompt.readOnly,
        ...(routedPrompt.workspaceContextQuery ? { workspaceContextQuery: routedPrompt.workspaceContextQuery } : {}),
      },
      (event) => {
        if (token.isCancellationRequested) return;
        const result = renderNativeChatEvent(event, registration.workspacePath, response);
        sawText ||= result.sawText;
        sawError ||= result.sawError;
      },
    );
  } catch (err) {
    sawError = true;
    response.markdown(`\n\n**Veyra error:** ${errorMessage(err)}`);
  } finally {
    cancellation.dispose();
  }

  if (!sawText && !sawError && !token.isCancellationRequested) {
    response.markdown('_No text response._');
  }

  return {
    ...(sawError ? { errorDetails: { message: 'Veyra completed with errors.' } } : {}),
    metadata: {
      participant: definition.name,
      forcedTarget: definition.forcedTarget,
    },
  };
}

function withWorkspaceContextQuery(
  routed: Omit<NativeChatRoutedPrompt, 'workspaceContextQuery'>,
  workspaceContextQuery: string | undefined,
): NativeChatRoutedPrompt {
  return workspaceContextQuery ? { ...routed, workspaceContextQuery } : routed;
}

function hasCodebaseMention(prompt: string): boolean {
  return parseWorkspaceContextMention(prompt).enabled;
}

function renderNativeChatEvent(
  event: VeyraDispatchEvent,
  workspacePath: string,
  response: vscode.ChatResponseStream,
): { sawText: boolean; sawError: boolean } {
  if (event.kind === 'system-message') {
    if (event.message.kind === 'facilitator-decision' && event.message.agentId) {
      const reason = event.message.reason ? `: ${event.message.reason}` : '';
      response.progress(`Routed to ${agentLabel(event.message.agentId)}${reason}`);
      return { sawText: false, sawError: false };
    }
    if (event.message.kind === 'routing-needed') {
      response.markdown(event.message.text);
      if (event.message.text.includes('Veyra: Configure Codex/Gemini CLI paths')) {
        response.button({
          command: 'veyra.configureCliPaths',
          title: 'Configure CLI paths',
        });
      }
      response.button({
        command: 'veyra.showSetupGuide',
        title: 'Open setup guide',
      });
      response.button({
        command: 'veyra.showLiveValidationGuide',
        title: 'Open live validation guide',
      });
      return { sawText: true, sawError: false };
    }
    if (event.message.kind === 'change-set' && event.message.changeSet) {
      response.markdown(`\n\n${event.message.text}`);
      if (event.message.changeSet.status === 'pending') {
        emitNativeChatButton(response, {
          command: 'veyra.openPendingChanges',
          title: 'Open pending changes',
          arguments: [event.message.changeSet.id],
        });
        emitNativeChatButton(response, {
          command: 'veyra.acceptPendingChanges',
          title: 'Accept pending changes',
          arguments: [event.message.changeSet.id],
        });
        emitNativeChatButton(response, {
          command: 'veyra.rejectPendingChanges',
          title: 'Reject pending changes',
          arguments: [event.message.changeSet.id],
        });
      }
      return { sawText: true, sawError: false };
    }
    if (event.message.kind === 'edit-conflict') {
      if (event.message.filePath) {
        response.reference(editedFileUri(workspacePath, event.message.filePath));
      }
      response.markdown(`\n\n**Edit conflict:** ${event.message.text}`);
      return { sawText: true, sawError: false };
    }
    if (event.message.kind === 'error' && event.message.filePath) {
      response.reference(editedFileUri(workspacePath, event.message.filePath));
      response.markdown(`\n\n> ${event.message.text.replace(/\r?\n/g, '\n> ')}`);
      return { sawText: false, sawError: Boolean(event.message.agentId) };
    }
    response.markdown(`\n\n> ${event.message.text.replace(/\r?\n/g, '\n> ')}`);
    return { sawText: false, sawError: true };
  }

  if (event.kind === 'dispatch-start') {
    response.progress(`${agentLabel(event.agentId)} is working...`);
    return { sawText: false, sawError: false };
  }

  if (event.kind === 'chunk') {
    if (event.chunk.type === 'text') {
      response.markdown(event.chunk.text);
      return { sawText: event.chunk.text.length > 0, sawError: false };
    }
    if (event.chunk.type === 'tool-call') {
      const renderStyle = readToolCallRenderStyle();
      if (renderStyle === 'hidden') {
        return { sawText: false, sawError: false };
      }
      response.progress(`${agentLabel(event.agentId)}: ${event.chunk.name}`);
      response.markdown(toolCallSummary(event.agentId, event.chunk.name, event.chunk.input, renderStyle));
      return { sawText: true, sawError: false };
    }
    if (event.chunk.type === 'tool-result') {
      const renderStyle = readToolCallRenderStyle();
      if (renderStyle === 'hidden') {
        return { sawText: false, sawError: false };
      }
      response.markdown(toolResultSummary(event.agentId, event.chunk.name, event.chunk.output, renderStyle));
      return { sawText: true, sawError: false };
    }
    if (event.chunk.type === 'error') {
      response.markdown(`\n\n**${agentLabel(event.agentId)} error:** ${event.chunk.message}`);
      return { sawText: false, sawError: true };
    }
    return { sawText: false, sawError: false };
  }

  if (event.kind === 'dispatch-end') {
    if (event.message.status === 'cancelled') {
      response.progress(`${agentLabel(event.agentId)} cancelled`);
    } else if (event.message.status === 'errored') {
      response.progress(`${agentLabel(event.agentId)} ended with errors`);
    }
    return { sawText: false, sawError: event.message.status === 'errored' };
  }

  if (event.kind === 'file-edited') {
    response.progress(`${agentLabel(event.agentId)} ${fileChangeVerb(event.changeKind)} ${event.path}`);
    response.reference(editedFileUri(workspacePath, event.path));
    return { sawText: true, sawError: false };
  }

  return { sawText: false, sawError: false };
}

function emitNativeChatButton(response: vscode.ChatResponseStream, command: vscode.Command): void {
  const button = (response as { button?: (command: vscode.Command) => void }).button;
  if (typeof button === 'function') {
    button.call(response, command);
  }
}

function createNativeChatSmokeResponseCollector(): { response: vscode.ChatResponseStream; text(): string } {
  const parts: string[] = [];
  const response = {
    markdown(value: string | vscode.MarkdownString) {
      parts.push(markdownValueText(value));
    },
    progress(value: string) {
      parts.push(value);
    },
    reference(value: unknown) {
      if (value && typeof value === 'object' && 'fsPath' in value && typeof value.fsPath === 'string') {
        parts.push(`[reference:${value.fsPath.replace(/\\/g, '/')}]`);
      }
    },
    button(value: vscode.Command) {
      const command = 'command' in value && typeof value.command === 'string' ? value.command : 'unknown';
      const title = 'title' in value && typeof value.title === 'string' ? value.title : command;
      parts.push(`[button:${title}:${command}]`);
    },
  } as vscode.ChatResponseStream;
  return {
    response,
    text: () => parts.join('\n'),
  };
}

function markdownValueText(value: string | vscode.MarkdownString): string {
  if (typeof value === 'string') return value;
  return value.value;
}

function promptWithChatReferences(request: NativeChatReferencePrompt, workspacePath?: string): string {
  const references = Array.isArray(request.references) ? request.references : [];
  const toolReferences = Array.isArray(request.toolReferences) ? request.toolReferences : [];
  if (references.length === 0 && toolReferences.length === 0) return request.prompt;

  let prompt = request.prompt;
  const replacements: ChatReferenceReplacement[] = [];
  const focusNotes: string[] = [];

  for (const reference of references) {
    const fileReference = chatReferenceFileReference(reference, workspacePath);
    const replacement = fileReference
      ? `@${fileReference.promptPath}`
      : chatReferenceText(reference);
    if (!replacement) continue;

    if (fileReference?.lineRange) {
      focusNotes.push(`Reference focus: ${fileReference.promptPath} ${fileReference.lineRange}`);
    }

    replacements.push({
      replacement,
      range: validReferenceRange(reference, request.prompt.length),
    });
  }

  for (const toolReference of toolReferences) {
    replacements.push({
      replacement: `[VS Code tool: ${toolReference.name}]`,
      range: validReferenceRange(toolReference, request.prompt.length),
    });
  }

  for (const item of replacements
    .filter((entry): entry is ChatReferenceReplacement & { range: [number, number] } => entry.range !== null)
    .sort((a, b) => b.range[0] - a.range[0])) {
    const [start, end] = item.range;
    prompt = `${prompt.slice(0, start)}${item.replacement}${prompt.slice(end)}`;
  }

  const appendedMentions = replacements
    .filter((entry) => entry.range === null)
    .map((entry) => entry.replacement);

  return [prompt.trimEnd(), ...appendedMentions, ...focusNotes].filter(Boolean).join('\n\n');
}

const NATIVE_CHAT_HISTORY_TURN_LIMIT = 8;

function withNativeChatHistory(
  prompt: string,
  chatContext: vscode.ChatContext | undefined,
  workspacePath?: string,
): string {
  const history = formatNativeChatHistory(chatContext, workspacePath);
  return history ? `${history}\n\n${prompt}` : prompt;
}

function formatNativeChatHistory(
  chatContext: vscode.ChatContext | undefined,
  workspacePath?: string,
): string | null {
  const history = Array.isArray(chatContext?.history)
    ? chatContext.history.slice(-NATIVE_CHAT_HISTORY_TURN_LIMIT)
    : [];
  const entries = history
    .map((turn) => nativeChatHistoryTurnToText(turn, workspacePath))
    .filter((entry): entry is string => entry !== null);

  if (entries.length === 0) return null;
  return [
    '[VS Code chat history]',
    ...entries,
    '[/VS Code chat history]',
  ].join('\n');
}

function nativeChatHistoryTurnToText(turn: unknown, workspacePath?: string): string | null {
  if (!isRecord(turn)) return null;
  const participant = typeof turn.participant === 'string' ? turn.participant : undefined;
  const participantSuffix = participant ? ` (${participant})` : '';

  if (typeof turn.prompt === 'string') {
    const references = Array.isArray(turn.references)
      ? turn.references as readonly vscode.ChatPromptReference[]
      : [];
    const toolReferences = Array.isArray(turn.toolReferences)
      ? turn.toolReferences as readonly vscode.ChatLanguageModelToolReference[]
      : [];
    const prompt = promptWithChatReferences({
      prompt: turn.prompt,
      references,
      toolReferences,
    }, workspacePath);
    return formatNativeChatTranscriptEntry(`User${participantSuffix}`, prompt);
  }

  const responseText = nativeChatResponseTurnText(turn);
  if (!responseText) return null;
  return formatNativeChatTranscriptEntry(`Assistant${participantSuffix}`, responseText);
}

function nativeChatResponseTurnText(turn: Record<string, unknown>): string | null {
  if (!Array.isArray(turn.response)) return null;
  const text = turn.response
    .map(nativeChatResponsePartToText)
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function nativeChatResponsePartToText(part: unknown): string | null {
  if (!isRecord(part)) return null;
  const value = part.value;
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.value === 'string') return value.value;
  return null;
}

function formatNativeChatTranscriptEntry(label: string, content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const [firstLine, ...continuationLines] = trimmed.split(/\r?\n/);
  return [
    `${label}: ${firstLine}`.trim(),
    ...continuationLines.map((line) => `  ${line}`),
  ].join('\n').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ChatReferenceReplacement {
  replacement: string;
  range: [number, number] | null;
}

function validReferenceRange(
  reference: RangedNativeChatReference,
  promptLength: number,
): [number, number] | null {
  if (
    Array.isArray(reference.range) &&
    reference.range.length === 2 &&
    Number.isInteger(reference.range[0]) &&
    Number.isInteger(reference.range[1]) &&
    reference.range[0] >= 0 &&
    reference.range[1] >= reference.range[0] &&
    reference.range[1] <= promptLength
  ) {
    return reference.range;
  }
  return null;
}

interface RangedNativeChatReference {
  readonly range?: [start: number, end: number];
}

function chatReferenceFileReference(
  reference: vscode.ChatPromptReference,
  workspacePath?: string,
): { promptPath: string; lineRange: string | null } | null {
  const fsPath = filePathFromReferenceValue(reference.value);
  if (!fsPath) return null;
  const lineRange = lineRangeFromReferenceValue(reference.value);
  return {
    promptPath: referencePathForPrompt(fsPath, workspacePath),
    lineRange,
  };
}

function chatReferenceText(reference: vscode.ChatPromptReference): string | null {
  if (typeof reference.value !== 'string' || reference.value.length === 0) return null;
  const label = reference.modelDescription ?? reference.id;
  return `${label}:\n${reference.value}`;
}

function filePathFromReferenceValue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.fsPath === 'string') return record.fsPath;
  if ('uri' in record) return filePathFromReferenceValue(record.uri);
  return null;
}

function lineRangeFromReferenceValue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!('range' in record)) return null;

  const range = record.range as Record<string, unknown> | undefined;
  const start = positionLine(range?.start);
  const end = positionLine(range?.end);
  if (start === null || end === null) return null;

  const startLine = start + 1;
  const endLine = Math.max(end + 1, startLine);
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function positionLine(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const line = (value as Record<string, unknown>).line;
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 ? line : null;
}

function referencePathForPrompt(fsPath: string, workspacePath?: string): string {
  if (workspacePath) {
    const relative = path.relative(workspacePath, fsPath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.replace(/\\/g, '/');
    }
  }
  return fsPath.replace(/\\/g, '/');
}

function editedFileUri(workspacePath: string, editedPath: string): vscode.Uri {
  return vscode.Uri.file(path.isAbsolute(editedPath) ? editedPath : path.join(workspacePath, editedPath));
}

function agentLabel(agentId: AgentId): string {
  if (agentId === 'claude') return 'Claude';
  if (agentId === 'codex') return 'Codex';
  return 'Gemini';
}

type ToolCallRenderStyle = 'verbose' | 'compact' | 'hidden';

function toolCallSummary(
  agentId: AgentId,
  toolName: string,
  input: unknown,
  renderStyle: ToolCallRenderStyle = 'compact',
): string {
  const detail = toolCallDetail(input);
  const summary = `\n\n_${agentLabel(agentId)} used ${toolName}${detail ? `: ${detail}` : ''}_`;
  return renderStyle === 'verbose' ? `${summary}${verboseToolPayload(input)}` : summary;
}

function toolResultSummary(
  agentId: AgentId,
  toolName: string,
  output: unknown,
  renderStyle: ToolCallRenderStyle = 'compact',
): string {
  const detail = compactToolOutput(output);
  const summary = `\n\n_${agentLabel(agentId)} ${toolName} result${detail ? `: ${detail}` : ''}_`;
  return renderStyle === 'verbose' ? `${summary}${verboseToolPayload(output)}` : summary;
}

function toolCallDetail(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'path', 'file_path', 'filePath', 'notebook_path', 'notebookPath']) {
    if (typeof record[key] === 'string' && record[key].length > 0) {
      return record[key];
    }
  }
  return null;
}

function fileChangeVerb(changeKind: 'created' | 'edited' | 'deleted' | undefined): string {
  if (changeKind === 'created') return 'created';
  return changeKind === 'deleted' ? 'deleted' : 'edited';
}

function compactToolOutput(output: unknown): string | null {
  const raw = typeof output === 'string' ? output : safeJson(output);
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function verboseToolPayload(value: unknown): string {
  const raw = typeof value === 'string' ? value : safeJsonPretty(value);
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const language = typeof value === 'string' ? 'text' : 'json';
  return `\n\n\`\`\`${language}\n${trimmed}\n\`\`\``;
}

function readToolCallRenderStyle(): ToolCallRenderStyle {
  const value = vscode.workspace.getConfiguration('veyra')
    .get<ToolCallRenderStyle>('toolCallRenderStyle', 'compact');
  return value === 'verbose' || value === 'hidden' ? value : 'compact';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function safeJsonPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
