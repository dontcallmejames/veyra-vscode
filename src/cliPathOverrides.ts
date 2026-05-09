import * as vscode from 'vscode';
import { normalizeCliPathOverride, type CliRuntimeName } from './cliPathValidation.js';

export function getCodexCliPathOverride(): string {
  return getCliPathOverride('codex', 'GAMBIT_CODEX_CLI_PATH', 'codexCliPath');
}

export function getGeminiCliPathOverride(): string {
  return getCliPathOverride('gemini', 'GAMBIT_GEMINI_CLI_PATH', 'geminiCliPath');
}

function getCliPathOverride(runtime: CliRuntimeName, envName: string, configKey: string): string {
  const envValue = process.env[envName]?.trim();
  if (envValue) return normalizeCliPathOverride(runtime, envValue);

  try {
    const configured = vscode.workspace.getConfiguration('gambit').get<string>(configKey, '').trim();
    return configured ? normalizeCliPathOverride(runtime, configured) : '';
  } catch {
    return '';
  }
}
