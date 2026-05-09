import { fileURLToPath } from 'node:url';

export function requireLiveOptIn(env = process.env) {
  if (env.GAMBIT_RUN_LIVE === '1') {
    return { ok: true };
  }
  return {
    ok: false,
    message: [
      'Gambit live integration tests require explicit paid-prompt opt-in.',
      '',
      'PowerShell:',
      "  $env:GAMBIT_RUN_LIVE = '1'",
      '  npm run verify:goal',
      '',
      'Or run only the live integration suite:',
      '  npm run test:integration:live',
      '  Remove-Item Env:\\GAMBIT_RUN_LIVE -ErrorAction SilentlyContinue',
      '',
      'Bash-compatible shells:',
      '  GAMBIT_RUN_LIVE=1 npm run verify:goal',
      '',
      'Or run only the live integration suite:',
      '  GAMBIT_RUN_LIVE=1 npm run test:integration:live',
    ].join('\n'),
  };
}

function main() {
  const result = requireLiveOptIn();
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
