import type { AgentStatus } from './types.js';

export const DIAGNOSTIC_COMMAND_IDS = [
  'veyra.openPanel',
  'veyra.checkStatus',
  'veyra.copyDiagnosticReport',
  'veyra.showSetupGuide',
  'veyra.showLiveValidationGuide',
  'veyra.configureCliPaths',
  'veyra.openPendingChanges',
  'veyra.acceptPendingChanges',
  'veyra.rejectPendingChanges',
  'veyra.createCheckpoint',
  'veyra.listCheckpoints',
  'veyra.rollbackLatestCheckpoint',
] as const;

export type DiagnosticAgentStatus = AgentStatus | `error: ${string}`;

export type OptionalSurfaceFailure = {
  label: string;
  message: string;
};

export type DiagnosticReportInput = {
  generatedAt: string;
  extensionId: string;
  extensionVersion: string;
  vscodeVersion: string;
  os: {
    platform: string;
    arch: string;
    release: string;
  };
  workspace: {
    trusted: boolean | 'unknown';
    folderCount: number;
    folderNames: string[];
    folderSchemes: string[];
  };
  agents: Record<'claude' | 'codex' | 'gemini', DiagnosticAgentStatus>;
  commands: Record<string, boolean>;
  nativeChatRegistrations: string[];
  optionalSurfaceFailures: OptionalSurfaceFailure[];
};

export function formatDiagnosticReport(input: DiagnosticReportInput): string {
  const workspaceFolders = input.workspace.folderCount === 0
    ? '0'
    : `${input.workspace.folderCount} (${input.workspace.folderNames.join(', ')})`;
  const workspaceTrusted = input.workspace.trusted === 'unknown'
    ? 'unknown'
    : input.workspace.trusted ? 'yes' : 'no';
  const commandLines = Object.entries(input.commands)
    .map(([command, registered]) => `- ${command}: ${registered ? 'registered' : 'missing'}`);
  const nativeChatRegistrations = input.nativeChatRegistrations.length > 0
    ? input.nativeChatRegistrations.join(', ')
    : 'none reported';
  const optionalSurfaceFailures = input.optionalSurfaceFailures.length > 0
    ? input.optionalSurfaceFailures.map((failure) => `${failure.label} - ${failure.message}`).join('; ')
    : 'none reported';

  return [
    '# Veyra Diagnostic Report',
    '',
    '## Environment',
    `- Generated: ${input.generatedAt}`,
    `- Extension: ${input.extensionId} ${input.extensionVersion}`,
    `- VS Code: ${input.vscodeVersion}`,
    `- OS: ${input.os.platform} ${input.os.arch} ${input.os.release}`,
    '',
    '## Workspace',
    `- Workspace trusted: ${workspaceTrusted}`,
    `- Workspace folders: ${workspaceFolders}`,
    `- Workspace schemes: ${input.workspace.folderSchemes.join(', ') || 'none'}`,
    '',
    '## Agents',
    `- Claude: ${formatStatus(input.agents.claude)}`,
    `- Codex: ${formatStatus(input.agents.codex)}`,
    `- Gemini: ${formatStatus(input.agents.gemini)}`,
    '',
    '## Commands',
    ...commandLines,
    '',
    '## Optional Surfaces',
    `- Native chat registrations: ${nativeChatRegistrations}`,
    `- Optional surface failures: ${optionalSurfaceFailures}`,
    '',
    '## Notes',
    '- Workspace folder paths are summarized by folder name to keep this report easier to share.',
    '- If a command is missing, run Developer: Reload Window, then retry the Veyra command.',
    '',
  ].join('\n');
}

function formatStatus(status: DiagnosticAgentStatus): string {
  if (status === 'not-installed') return 'not installed';
  if (status === 'node-missing') return 'Node.js missing';
  return status;
}
