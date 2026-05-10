import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;

export function readWorkspaceRules(workspacePath: string): string {
  const file = path.join(workspacePath, 'veyra.md').replace(/\\/g, '/');
  try {
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
