import * as path from 'node:path';
import * as vscode from 'vscode';
import type { VeyraDispatchEvent, VeyraForcedTarget, VeyraSessionService } from './veyraService.js';
import type { AgentId } from './types.js';
import { veyraWorkflowPrompt, type VeyraWorkflowCommand } from './workflowPrompts.js';
import { parseWorkspaceContextMention } from './workspaceContext.js';

export interface VeyraLanguageModelInfo extends vscode.LanguageModelChatInformation {
  readonly forcedTarget: VeyraForcedTarget;
  readonly workflowCommand?: VeyraWorkflowCommand;
}

export interface VeyraLanguageModelRegistration {
  service: VeyraSessionService;
  workspacePath: string;
}

export const VEYRA_LANGUAGE_MODELS: readonly VeyraLanguageModelInfo[] = [
  {
    id: 'veyra-orchestrator',
    name: 'Veyra',
    family: 'veyra',
    version: 'local-cli',
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    tooltip: 'Route the request to Claude, Codex, or Gemini using Veyra context.',
    detail: 'Orchestrator',
    capabilities: {},
    forcedTarget: 'veyra',
  },
  {
    id: 'veyra-review',
    name: 'Veyra Review',
    family: 'veyra',
    version: 'local-cli',
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    tooltip: 'Run a read-only all-agent review through Claude, Codex, and Gemini.',
    detail: 'Workflow',
    capabilities: {},
    forcedTarget: 'veyra',
    workflowCommand: 'review',
  },
  {
    id: 'veyra-debate',
    name: 'Veyra Debate',
    family: 'veyra',
    version: 'local-cli',
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    tooltip: 'Run a read-only all-agent debate through Claude, Codex, and Gemini.',
    detail: 'Workflow',
    capabilities: {},
    forcedTarget: 'veyra',
    workflowCommand: 'debate',
  },
  {
    id: 'veyra-implement',
    name: 'Veyra Implement',
    family: 'veyra',
    version: 'local-cli',
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    tooltip: 'Run a serial all-agent implementation workflow through Claude, Codex, and Gemini.',
    detail: 'Workflow',
    capabilities: {},
    forcedTarget: 'veyra',
    workflowCommand: 'implement',
  },
  {
    id: 'veyra-claude',
    name: 'Claude via Veyra',
    family: 'claude',
    version: 'local-cli',
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    tooltip: 'Send the request directly to Claude through Veyra.',
    detail: 'Direct agent',
    capabilities: {},
    forcedTarget: 'claude',
  },
  {
    id: 'veyra-codex',
    name: 'Codex via Veyra',
    family: 'codex',
    version: 'local-cli',
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    tooltip: 'Send the request directly to Codex through Veyra.',
    detail: 'Direct agent',
    capabilities: {},
    forcedTarget: 'codex',
  },
  {
    id: 'veyra-gemini',
    name: 'Gemini via Veyra',
    family: 'gemini',
    version: 'local-cli',
    maxInputTokens: 128_000,
    maxOutputTokens: 32_000,
    tooltip: 'Send the request directly to Gemini through Veyra.',
    detail: 'Direct agent',
    capabilities: {},
    forcedTarget: 'gemini',
  },
];

export function registerVeyraLanguageModelProvider(
  context: vscode.ExtensionContext,
  getRegistration: () => VeyraLanguageModelRegistration | undefined,
): void {
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(
      'veyra',
      new VeyraLanguageModelProvider(getRegistration),
    ),
  );
}

export function resolveVeyraLanguageModel(modelId: string): VeyraLanguageModelInfo {
  return VEYRA_LANGUAGE_MODELS.find((model) => model.id === modelId) ?? VEYRA_LANGUAGE_MODELS[0];
}

export function languageModelMessagesToPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  return messages
    .map((message) => {
      const label = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'Assistant' : 'User';
      const name = message.name ? ` (${message.name})` : '';
      const content = message.content.map(languageModelPartToText).filter(Boolean).join('\n');
      if (!content.trim()) return '';
      return formatTranscriptEntry(`${label}${name}`, content);
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

class VeyraLanguageModelProvider implements vscode.LanguageModelChatProvider<VeyraLanguageModelInfo> {
  constructor(
    private readonly getRegistration: () => VeyraLanguageModelRegistration | undefined,
  ) {}

  provideLanguageModelChatInformation(): vscode.ProviderResult<VeyraLanguageModelInfo[]> {
    return [...VEYRA_LANGUAGE_MODELS];
  }

  async provideLanguageModelChatResponse(
    model: VeyraLanguageModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const registration = this.getRegistration();
    if (!registration) {
      progress.report(new vscode.LanguageModelTextPart('Open a workspace folder before using Veyra language models.'));
      return;
    }

    const selectedModel = resolveVeyraLanguageModel(model.id);
    if (token.isCancellationRequested) return;

    const transcriptPrompt = languageModelMessagesToPrompt(messages);
    if (!transcriptPrompt.trim()) {
      progress.report(new vscode.LanguageModelTextPart('Provide a prompt before using Veyra language models.'));
      return;
    }
    const prompt = withLanguageModelRequestContext(transcriptPrompt, _options);

    const cancellation = token.onCancellationRequested(() => {
      void registration.service.cancelAll();
    });

    const routedText = selectedModel.workflowCommand
      ? veyraWorkflowPrompt(selectedModel.workflowCommand, prompt)
      : prompt;
    const readOnly = selectedModel.workflowCommand === 'review' || selectedModel.workflowCommand === 'debate';
    const workspaceContextQuery = languageModelWorkspaceContextQuery(messages);

    let reportedOutput = false;
    try {
      await registration.service.dispatch(
        {
          text: routedText,
          source: 'language-model',
          cwd: registration.workspacePath,
          forcedTarget: selectedModel.forcedTarget,
          readOnly: readOnly || undefined,
          ...(workspaceContextQuery ? { workspaceContextQuery } : {}),
        },
        (event) => {
          if (token.isCancellationRequested) return;
          reportedOutput = reportLanguageModelEvent(event, progress, registration.workspacePath) || reportedOutput;
        },
      );
    } catch (err) {
      reportedOutput = true;
      progress.report(new vscode.LanguageModelTextPart(`\n\n**Veyra error:** ${errorMessage(err)}`));
    } finally {
      cancellation.dispose();
    }

    if (!reportedOutput && !token.isCancellationRequested) {
      progress.report(new vscode.LanguageModelTextPart('_No text response._'));
    }
  }

  async provideTokenCount(
    _model: VeyraLanguageModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    const value = typeof text === 'string'
      ? text
      : text.content.map(languageModelPartToText).join('\n');
    return Math.ceil(value.length / 4);
  }
}

function languageModelWorkspaceContextQuery(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string | undefined {
  const lastUserMessage = [...messages].reverse().find((message) =>
    message.role === vscode.LanguageModelChatMessageRole.User
  );
  if (!lastUserMessage) return undefined;

  const query = lastUserMessage.content.map(languageModelPartToText).filter(Boolean).join('\n').trim();
  return parseWorkspaceContextMention(query).enabled ? query : undefined;
}

function reportLanguageModelEvent(
  event: VeyraDispatchEvent,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  workspacePath: string,
): boolean {
  if (event.kind === 'dispatch-start') {
    progress.report(new vscode.LanguageModelTextPart(`\n\n_${agentLabel(event.agentId)} is working..._`));
    return true;
  }

  if (event.kind === 'dispatch-end') {
    if (event.message.status === 'cancelled') {
      progress.report(new vscode.LanguageModelTextPart(`\n\n_${agentLabel(event.agentId)} cancelled_`));
      return true;
    }
    if (event.message.status === 'errored') {
      progress.report(new vscode.LanguageModelTextPart(`\n\n_${agentLabel(event.agentId)} ended with errors_`));
      return true;
    }
    return false;
  }

  if (event.kind === 'chunk') {
    if (event.chunk.type === 'text') {
      progress.report(new vscode.LanguageModelTextPart(event.chunk.text));
      return event.chunk.text.length > 0;
    }
    if (event.chunk.type === 'error') {
      progress.report(new vscode.LanguageModelTextPart(`\n\n**${agentLabel(event.agentId)} error:** ${event.chunk.message}`));
      return true;
    }
    if (event.chunk.type === 'tool-call') {
      const renderStyle = readToolCallRenderStyle();
      if (renderStyle === 'hidden') return false;
      progress.report(new vscode.LanguageModelTextPart(
        toolCallSummary(event.agentId, event.chunk.name, event.chunk.input, renderStyle),
      ));
      return true;
    }
    if (event.chunk.type === 'tool-result') {
      const renderStyle = readToolCallRenderStyle();
      if (renderStyle === 'hidden') return false;
      progress.report(new vscode.LanguageModelTextPart(
        toolResultSummary(event.agentId, event.chunk.name, event.chunk.output, renderStyle),
      ));
      return true;
    }
    return false;
  }

  if (event.kind === 'system-message') {
    if (event.message.kind === 'facilitator-decision' && event.message.agentId) {
      const reason = event.message.reason ? `: ${event.message.reason}` : '';
      progress.report(new vscode.LanguageModelTextPart(`\n\n_Routed to ${agentLabel(event.message.agentId)}${reason}_\n\n`));
      return true;
    } else if (event.message.kind === 'routing-needed') {
      progress.report(new vscode.LanguageModelTextPart(event.message.text));
      return event.message.text.length > 0;
    } else if (event.message.kind === 'change-set' && event.message.changeSet) {
      const changeSet = event.message.changeSet;
      progress.report(new vscode.LanguageModelTextPart(
        `Veyra pending changes: ${agentLabel(changeSet.agentId)} changed ${formatFileCount(changeSet.fileCount)}. Use Veyra: Open Pending Changes to inspect.`,
      ));
      return true;
    } else if (event.message.kind === 'edit-conflict') {
      const text = linkWorkspaceFile(workspacePath, event.message.text, event.message.filePath);
      progress.report(new vscode.LanguageModelTextPart(`\n\n_Edit conflict: ${text}_`));
      return true;
    } else if (event.message.kind === 'error' && event.message.filePath) {
      const text = linkWorkspaceFile(workspacePath, event.message.text, event.message.filePath);
      progress.report(new vscode.LanguageModelTextPart(`\n\n> ${text.replace(/\r?\n/g, '\n> ')}`));
      return true;
    } else {
      progress.report(new vscode.LanguageModelTextPart(`\n\n> ${event.message.text.replace(/\r?\n/g, '\n> ')}`));
      return event.message.text.length > 0;
    }
  }

  if (event.kind === 'file-edited') {
    const uri = editedFileUri(workspacePath, event.path);
    progress.report(new vscode.LanguageModelTextPart(`\n\n_${agentLabel(event.agentId)} ${fileChangeVerb(event.changeKind)} [${event.path}](${uri.toString()})_`));
    return true;
  }

  return false;
}

function editedFileUri(workspacePath: string, editedPath: string): vscode.Uri {
  return vscode.Uri.file(path.isAbsolute(editedPath) ? editedPath : path.join(workspacePath, editedPath));
}

function linkWorkspaceFile(workspacePath: string, text: string, filePath: string | undefined): string {
  if (!filePath) return text;
  const uri = editedFileUri(workspacePath, filePath);
  const link = `[${filePath}](${uri.toString()})`;
  return text.includes(filePath) ? text.replace(filePath, link) : `${text} (${link})`;
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

function formatFileCount(fileCount: number): string {
  return `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
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

function languageModelPartToText(part: vscode.LanguageModelInputPart | unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (typeof part === 'object' && part !== null) {
    const record = part as Record<string, unknown>;
    if (typeof record.value === 'string') {
      return record.value;
    }
    if (isLanguageModelDataRecord(record)) {
      return languageModelDataPartToText(record.data, record.mimeType);
    }
    if (typeof record.name === 'string' && 'input' in record) {
      const callId = typeof record.callId === 'string' && record.callId.length > 0
        ? `${record.callId} `
        : '';
      return `[tool call ${callId}${record.name}] ${safeJson(record.input)}`;
    }
    if (typeof record.callId === 'string' && Array.isArray(record.content)) {
      return `[tool result ${record.callId}] ${record.content.map(languageModelPartToText).join('\n')}`;
    }
  }

  if (typeof part === 'string') {
    return part;
  }

  return safeJson(part);
}

function withLanguageModelRequestContext(
  prompt: string,
  options: vscode.ProvideLanguageModelChatResponseOptions,
): string {
  const sections: string[] = [];
  const modelOptions = languageModelModelOptionsToText(options.modelOptions);
  if (modelOptions) {
    sections.push(
      '[VS Code model options]',
      modelOptions,
      '[/VS Code model options]',
      '',
    );
  }

  const tools = Array.isArray(options.tools) ? options.tools : [];
  if (tools.length > 0) {
    sections.push(
      '[VS Code request tools]',
      `Tool mode: ${languageModelToolModeLabel(options.toolMode)}`,
      ...tools.map(languageModelRequestToolToText),
      '[/VS Code request tools]',
      '',
    );
  }

  if (sections.length === 0) return prompt;
  return [...sections, prompt].join('\n');
}

function languageModelModelOptionsToText(
  modelOptions: vscode.ProvideLanguageModelChatResponseOptions['modelOptions'],
): string {
  if (typeof modelOptions !== 'object' || modelOptions === null) return '';
  const entries = Object.entries(modelOptions);
  if (entries.length === 0) return '';

  return safeJson(modelOptions);
}

function languageModelRequestToolToText(tool: vscode.LanguageModelChatTool): string {
  const schema = tool.inputSchema === undefined ? '' : `\n  inputSchema: ${safeJson(tool.inputSchema)}`;
  return `- ${tool.name}: ${tool.description}${schema}`;
}

function languageModelToolModeLabel(mode: vscode.LanguageModelChatToolMode | undefined): string {
  return mode === 2 ? 'required' : 'auto';
}

function isLanguageModelDataRecord(
  record: Record<string, unknown>,
): record is { data: Uint8Array; mimeType: string } {
  return record.data instanceof Uint8Array && typeof record.mimeType === 'string';
}

function languageModelDataPartToText(data: Uint8Array, mimeType: string): string {
  if (isTextMimeType(mimeType)) {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
  }
  return `[data ${mimeType} ${data.byteLength} bytes]`;
}

function isTextMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(';', 1)[0].trim();
  return normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/xml' ||
    normalized.endsWith('+xml');
}

function formatTranscriptEntry(label: string, content: string): string {
  const [firstLine, ...continuationLines] = trimOuterBlankLines(content).split(/\r?\n/);
  return [
    `${label}: ${firstLine}`.trim(),
    ...continuationLines.map((line) => `  ${line}`),
  ].join('\n').trim();
}

function trimOuterBlankLines(value: string): string {
  return value
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '');
}

function agentLabel(agentId: AgentId): string {
  if (agentId === 'claude') return 'Claude';
  if (agentId === 'codex') return 'Codex';
  return 'Gemini';
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
