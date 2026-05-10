import { fileURLToPath } from 'node:url';

export function requireLiveOptIn(env = process.env) {
  if (env.VEYRA_RUN_LIVE === '1') {
    return { ok: true };
  }
  return {
    ok: false,
    message: [
      'Veyra live integration tests require explicit paid-prompt opt-in.',
      '',
      'PowerShell:',
      "  $env:VEYRA_RUN_LIVE = '1'",
      '  npm run verify:goal',
      '',
      'Or run only the live integration suite:',
      '  npm run test:integration:live',
      '  Remove-Item Env:\\VEYRA_RUN_LIVE -ErrorAction SilentlyContinue',
      '',
      'Bash-compatible shells:',
      '  VEYRA_RUN_LIVE=1 npm run verify:goal',
      '',
      'Or run only the live integration suite:',
      '  VEYRA_RUN_LIVE=1 npm run test:integration:live',
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
