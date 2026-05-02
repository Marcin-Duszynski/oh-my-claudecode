import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(join(ROOT, relativePath), 'utf-8');
}

async function readOptionalSource(relativePath: string): Promise<string> {
  const path = join(ROOT, relativePath);
  return existsSync(path) ? readFile(path, 'utf-8') : '';
}

function assertNoForbiddenGitStrategy(source: string, label: string): void {
  expect(source, `${label} must not use -X ours/theirs`).not.toMatch(/-X\s*(?:ours|theirs)\b/);
  expect(source, `${label} must not use ours/theirs strategy options`).not.toMatch(/--strategy-option[=\s](?:ours|theirs)\b/);
}

function assertNoFinalHistoryRewriteAutomation(source: string, label: string): void {
  expect(source, `${label} must not automate final history rewrite`).not.toMatch(/git[^\n]*(?:rebase\s+-i|filter-branch|commit\s+--amend|reset\s+--soft)/);
}

describe('hook-primary PostToolUse E2E contract guardrails', () => {
  it('preserves fallback team monitoring instead of removing polling/runtime recovery', async () => {
    const runtimeSource = await readSource('src/team/runtime.ts');
    const workerHookSource = await readSource('src/hooks/team-worker-hook.ts');

    expect(runtimeSource).toMatch(/export async function monitorTeam\s*\(/);
    expect(workerHookSource).toMatch(/maybeNotifyLeaderWorkerIdle|updateWorkerHeartbeat/);
  });

  it('does not add conflict auto-repair or final-history rewrite automation to hook paths', async () => {
    const hookSources = [
      ['hooks/bridge', await readSource('src/hooks/bridge.ts')],
      ['hooks/team-worker-hook', await readSource('src/hooks/team-worker-hook.ts')],
      ['hooks/team-dispatch-hook', await readSource('src/hooks/team-dispatch-hook.ts')],
      ['scripts/notify-hook/team-worker-posttooluse', await readOptionalSource('src/scripts/notify-hook/team-worker-posttooluse.ts')],
    ] as const;

    for (const [label, source] of hookSources) {
      assertNoForbiddenGitStrategy(source, label);
      assertNoFinalHistoryRewriteAutomation(source, label);
    }
  });

  it('keeps PostToolUse handling in the hook bridge without adding worker git repair side effects', async () => {
    const bridgeSource = await readSource('src/hooks/bridge.ts');

    expect(bridgeSource).toMatch(/processPostToolUse/);
    expect(bridgeSource).toMatch(/post-tool-use/);
    expect(bridgeSource).toMatch(/toolOutput/);
    assertNoForbiddenGitStrategy(bridgeSource, 'hooks/bridge PostToolUse path');
    assertNoFinalHistoryRewriteAutomation(bridgeSource, 'hooks/bridge PostToolUse path');
  });
});
