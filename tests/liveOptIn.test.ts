import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import packageJson from '../package.json';

describe('live integration npm opt-in guard', () => {
  it('gates the all-requirements goal verifier before non-paid checks start', () => {
    expect(packageJson.scripts['preverify:goal']).toBe('node scripts/require-live-opt-in.mjs');
    expect(packageJson.scripts['verify:goal']).toBe(
      'npm run verify:completion && npm run test:integration:live',
    );
  });

  it('runs before live readiness so npm live tests cannot pass while skipped', () => {
    expect(packageJson.scripts['pretest:integration:live']).toBe(
      'node scripts/require-live-opt-in.mjs && npm run verify:live-ready',
    );
  });

  it('prints the residual manual Extension Host gate after live suites pass', () => {
    expect(packageJson.scripts['posttest:integration:live']).toBe(
      'node scripts/print-extension-host-check.mjs --after-live',
    );
  });

  it('exposes the manual Extension Host checklist as a repeatable npm command', () => {
    expect(packageJson.scripts['manual:extension-host-check']).toBe(
      'node scripts/print-extension-host-check.mjs',
    );
  });

  it('prints exact manual chat prompts and evidence fields after live suites pass', () => {
    const output = execFileSync(process.execPath, ['scripts/print-extension-host-check.mjs', '--after-live'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    const debateIndex = output.indexOf('@veyra /debate choose a safe test-only change for this project');
    const reviewIndex = output.indexOf('@veyra /review inspect this workspace and report risks only');
    const consensusIndex = output.indexOf('@veyra /consensus decide whether the test-only change should be made now');
    const implementIndex = output.indexOf('@veyra /implement make a tiny test-only change, then review it');

    expect(debateIndex).toBeGreaterThanOrEqual(0);
    expect(reviewIndex).toBeGreaterThan(debateIndex);
    expect(consensusIndex).toBeGreaterThan(reviewIndex);
    expect(implementIndex).toBeGreaterThan(consensusIndex);
    expect(output).toContain('If /debate does not end with "Veyra completed with errors.", continue with:');
    expect(output).toContain('Manual evidence to paste back:');
    expect(output).toContain('/debate final error gone');
    expect(output).toContain('Do this next in VS Code, not PowerShell.');
    expect(output).toContain('Press F5');
    expect(output).toContain('Extension Development Host');
    expect(output).toContain('throwaway folder');
    expect(output).toContain('all-agent routing');
    expect(output).toContain('read-only review/debate/consensus');
    expect(output).toContain('visible file edits');
    expect(output).toContain('edit-conflict surfacing');
  });

  it('prints the same Extension Host checklist without live-test completion wording when run directly', () => {
    const output = execFileSync(process.execPath, ['scripts/print-extension-host-check.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).not.toContain('Paid live integration suites completed.');
    expect(output).toContain('Manual Extension Host check instructions.');
    expect(output).toContain('Do this in VS Code, not PowerShell.');
    expect(output).toContain('@veyra /debate choose a safe test-only change for this project');
    expect(output).toContain('@veyra /consensus decide whether the test-only change should be made now');
    expect(output).toContain('@veyra /implement make a tiny test-only change, then review it');
    expect(output).toContain('If /debate does not end with "Veyra completed with errors.", continue with:');
    expect(output).toContain('Manual evidence to paste back:');
  });

  it('requires VEYRA_RUN_LIVE=1 before the npm live-test entrypoint can continue', async () => {
    // @ts-expect-error The opt-in guard is a plain Node .mjs script used by npm preflight.
    const { requireLiveOptIn } = await import('../scripts/require-live-opt-in.mjs') as {
      requireLiveOptIn(env?: Record<string, string | undefined>): {
        ok: boolean;
        message?: string;
      };
    };

    expect(requireLiveOptIn({})).toEqual({
      ok: false,
      message: expect.stringContaining('VEYRA_RUN_LIVE=1'),
    });
    expect(requireLiveOptIn({}).message).toContain('npm run verify:goal');
    expect(requireLiveOptIn({ VEYRA_RUN_LIVE: '0' })).toEqual({
      ok: false,
      message: expect.stringContaining('VEYRA_RUN_LIVE=1'),
    });
    expect(requireLiveOptIn({ VEYRA_RUN_LIVE: '1' })).toEqual({ ok: true });
  });
});
