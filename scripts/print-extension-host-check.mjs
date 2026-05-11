import { pathToFileURL } from 'node:url';

export function extensionHostCheckLines({ afterLive = false } = {}) {
  return [
    '',
    ...(afterLive
      ? [
          'Paid live integration suites completed.',
          '',
          'Do this next in VS Code, not PowerShell.',
        ]
      : [
          'Manual Extension Host check instructions.',
          '',
          'Do this in VS Code, not PowerShell.',
        ]),
    '',
    'Remaining manual Extension Host gate:',
    '  1. Open this repo in VS Code.',
    '  2. Press F5, or run the Run Extension launch configuration.',
    '  3. In the Extension Development Host, open a throwaway folder or disposable test workspace.',
    '  4. Open VS Code Chat in that Extension Development Host.',
    '  5. Send this prompt first:',
    '     @veyra /debate choose a safe test-only change for this project',
    '  6. If /debate does not end with "Veyra completed with errors.", continue with:',
    '     @veyra /review inspect this workspace and report risks only',
    '     @veyra /consensus decide whether the test-only change should be made now',
    '     @veyra /implement make a tiny test-only change, then review it',
    '  7. Confirm all-agent routing, read-only review/debate/consensus, write-capable implement, shared context, visible file edits, and edit-conflict surfacing.',
    '  8. Record the result in docs/goal-completion-audit.md before marking the goal complete.',
    '',
    'Manual evidence to paste back:',
    '  /debate final error gone: pass/fail',
    '  all-agent routing: pass/fail',
    '  read-only review/debate/consensus: pass/fail',
    '  write-capable implement: pass/fail',
    '  shared context: pass/fail',
    '  visible file edits: pass/fail',
    '  edit-conflict surfacing: pass/fail',
    '',
    'Do not mark the goal complete until that manual paid Extension Host check is recorded.',
  ];
}

export function printExtensionHostCheck(options = {}) {
  process.stdout.write(`${extensionHostCheckLines(options).join('\n')}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (import.meta.url === invokedPath) {
  printExtensionHostCheck({ afterLive: process.argv.includes('--after-live') });
}
