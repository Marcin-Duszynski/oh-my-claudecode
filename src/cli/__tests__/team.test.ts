import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  killWorkerPanes: vi.fn(),
  resumeTeam: vi.fn(),
  monitorTeam: vi.fn(),
  shutdownTeam: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

vi.mock('../../team/tmux-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../team/tmux-session.js')>();
  return {
    ...actual,
    killWorkerPanes: mocks.killWorkerPanes,
  };
});

vi.mock('../../team/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../team/runtime.js')>();
  return {
    ...actual,
    resumeTeam: mocks.resumeTeam,
    monitorTeam: mocks.monitorTeam,
    shutdownTeam: mocks.shutdownTeam,
  };
});

describe('team cli', () => {
  let jobsDir: string;

  beforeEach(() => {
    jobsDir = mkdtempSync(join(tmpdir(), 'omc-team-cli-jobs-'));
    process.env.OMC_JOBS_DIR = jobsDir;
    process.env.OMC_RUNTIME_CLI_PATH = '/tmp/runtime-cli.cjs';
    mocks.spawn.mockReset();
    mocks.killWorkerPanes.mockReset();
    mocks.resumeTeam.mockReset();
    mocks.monitorTeam.mockReset();
    mocks.shutdownTeam.mockReset();
  });

  afterEach(() => {
    delete process.env.OMC_JOBS_DIR;
    delete process.env.OMC_RUNTIME_CLI_PATH;
    rmSync(jobsDir, { recursive: true, force: true });
  });

  it('startTeamJob starts runtime-cli and persists running job', async () => {
    const write = vi.fn();
    const end = vi.fn();
    const unref = vi.fn();
    mocks.spawn.mockReturnValue({
      pid: 4242,
      stdin: { write, end },
      unref,
    });

    const { startTeamJob } = await import('../team.js');

    const result = await startTeamJob({
      teamName: 'mvp-team',
      agentTypes: ['codex'],
      tasks: [{ subject: 'one', description: 'desc' }],
      cwd: '/tmp/project',
    });

    expect(result.status).toBe('running');
    expect(result.jobId).toMatch(/^omc-[a-z0-9]{1,12}$/);
    expect(result.pid).toBe(4242);

    expect(mocks.spawn).toHaveBeenCalledWith(
      'node',
      ['/tmp/runtime-cli.cjs'],
      expect.objectContaining({
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      }),
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    const savedJob = JSON.parse(readFileSync(join(jobsDir, `${result.jobId}.json`), 'utf-8')) as { status: string; pid: number };
    expect(savedJob.status).toBe('running');
    expect(savedJob.pid).toBe(4242);
  });

  it('getTeamJobStatus converges to result artifact state', async () => {
    const { getTeamJobStatus } = await import('../team.js');

    const jobId = 'omc-abc123';
    writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
      status: 'running',
      startedAt: Date.now() - 2_000,
      teamName: 'demo',
      cwd: '/tmp/demo',
    }));
    writeFileSync(join(jobsDir, `${jobId}-result.json`), JSON.stringify({
      status: 'completed',
      teamName: 'demo',
      taskResults: [],
    }));

    const status = await getTeamJobStatus(jobId);
    expect(status.status).toBe('completed');
    expect(status.result).toEqual(expect.objectContaining({ status: 'completed' }));

    const persisted = JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf-8')) as { status: string };
    expect(persisted.status).toBe('completed');
  });

  it('waitForTeamJob times out with running status', async () => {
    const { waitForTeamJob } = await import('../team.js');

    const jobId = 'omc-timeout1';
    writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
      status: 'running',
      startedAt: Date.now(),
      teamName: 'demo',
      cwd: '/tmp/demo',
    }));

    const result = await waitForTeamJob(jobId, { timeoutMs: 10 });
    expect(result.status).toBe('running');
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('Timed out waiting for job');
  });

  it('cleanupTeamJob kills worker panes and clears team state root', async () => {
    const { cleanupTeamJob } = await import('../team.js');

    const jobId = 'omc-cleanup1';
    const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-cleanup-'));
    const stateRoot = join(cwd, '.omc', 'state', 'team', 'demo-team');
    mkdirSync(stateRoot, { recursive: true });

    writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
      status: 'running',
      startedAt: Date.now(),
      teamName: 'demo-team',
      cwd,
    }));

    writeFileSync(join(jobsDir, `${jobId}-panes.json`), JSON.stringify({
      paneIds: ['%11', '%12'],
      leaderPaneId: '%10',
    }));

    const result = await cleanupTeamJob(jobId, 1234);

    expect(result.message).toContain('Cleaned up 2 worker pane(s)');
    expect(mocks.killWorkerPanes).toHaveBeenCalledWith({
      paneIds: ['%11', '%12'],
      leaderPaneId: '%10',
      teamName: 'demo-team',
      cwd,
      graceMs: 1234,
    });
    expect(existsSync(stateRoot)).toBe(false);

    rmSync(cwd, { recursive: true, force: true });
  });

  it('team status supports team-name target via runtime snapshot', async () => {
    const { teamCommand } = await import('../team.js');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mocks.resumeTeam.mockResolvedValue({
      teamName: 'demo-team',
      sessionName: 'omc-team-demo:0',
      leaderPaneId: '%0',
      config: { teamName: 'demo-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo' },
      workerNames: ['worker-1'],
      workerPaneIds: ['%1'],
      activeWorkers: new Map(),
      cwd: '/tmp/demo',
    });
    mocks.monitorTeam.mockResolvedValue({
      teamName: 'demo-team',
      phase: 'executing',
      workers: [],
      taskCounts: { pending: 0, inProgress: 1, completed: 0, failed: 0 },
      deadWorkers: [],
      monitorPerformance: { listTasksMs: 0, workerScanMs: 0, totalMs: 0 },
    });

    await teamCommand(['status', 'demo-team', '--json']);

    expect(mocks.resumeTeam).toHaveBeenCalledWith('demo-team', process.cwd());
    expect(mocks.monitorTeam).toHaveBeenCalled();
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string) as { running: boolean; snapshot: { phase: string } };
    expect(payload.running).toBe(true);
    expect(payload.snapshot.phase).toBe('executing');

    logSpy.mockRestore();
  });

  it('team resume invokes runtime resumeTeam', async () => {
    const { teamCommand } = await import('../team.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mocks.resumeTeam.mockResolvedValue({
      teamName: 'alpha-team',
      sessionName: 'omc-team-alpha:0',
      leaderPaneId: '%0',
      config: { teamName: 'alpha-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo' },
      workerNames: ['worker-1'],
      workerPaneIds: ['%1'],
      activeWorkers: new Map([['worker-1', { paneId: '%1', taskId: '1', spawnedAt: Date.now() }]]),
      cwd: '/tmp/demo',
    });

    await teamCommand(['resume', 'alpha-team', '--json']);

    expect(mocks.resumeTeam).toHaveBeenCalledWith('alpha-team', process.cwd());
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string) as { resumed: boolean; activeWorkers: number };
    expect(payload.resumed).toBe(true);
    expect(payload.activeWorkers).toBe(1);

    logSpy.mockRestore();
  });

  it('team shutdown supports --force and calls runtime shutdown', async () => {
    const { teamCommand } = await import('../team.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mocks.resumeTeam.mockResolvedValue({
      teamName: 'beta-team',
      sessionName: 'omc-team-beta:0',
      leaderPaneId: '%0',
      config: { teamName: 'beta-team', workerCount: 1, agentTypes: ['codex'], tasks: [], cwd: '/tmp/demo' },
      workerNames: ['worker-1'],
      workerPaneIds: ['%1'],
      activeWorkers: new Map(),
      cwd: '/tmp/demo',
    });

    await teamCommand(['shutdown', 'beta-team', '--force', '--json']);

    expect(mocks.shutdownTeam).toHaveBeenCalledWith('beta-team', 'omc-team-beta:0', '/tmp/demo', 0, ['%1'], '%0');
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string) as { shutdown: boolean; forced: boolean };
    expect(payload.shutdown).toBe(true);
    expect(payload.forced).toBe(true);

    logSpy.mockRestore();
  });

  it('legacy shorthand start alias supports optional ralph token', async () => {
    const write = vi.fn();
    const end = vi.fn();
    const unref = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mocks.spawn.mockReturnValue({
      pid: 5151,
      stdin: { write, end },
      unref,
    });

    const { teamCommand } = await import('../team.js');
    await teamCommand(['ralph', '2:codex', 'ship', 'feature', '--json']);

    expect(write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(write.mock.calls[0][0] as string) as { agentTypes: string[]; tasks: Array<{ subject: string; description: string }> };
    expect(payload.agentTypes).toEqual(['codex', 'codex']);
    expect(payload.tasks[0].subject).toContain('Ralph');
    expect(payload.tasks[0].description).toBe('ship feature');

    const out = JSON.parse(logSpy.mock.calls[0][0] as string) as { status: string; pid: number };
    expect(out.status).toBe('running');
    expect(out.pid).toBe(5151);

    logSpy.mockRestore();
  });

  it('team api supports list-tasks and read-config', async () => {
    const { teamCommand } = await import('../team.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const cwd = mkdtempSync(join(tmpdir(), 'omc-team-cli-api-'));
    const root = join(cwd, '.omc', 'state', 'team', 'api-team');
    mkdirSync(join(root, 'tasks'), { recursive: true });
    writeFileSync(join(root, 'tasks', '1.json'), JSON.stringify({ id: '1', status: 'pending' }));
    writeFileSync(join(root, 'config.json'), JSON.stringify({ teamName: 'api-team', workerCount: 1 }));

    await teamCommand(['api', 'list-tasks', '--input', JSON.stringify({ teamName: 'api-team' }), '--json', '--cwd', cwd]);
    const listPayload = JSON.parse(logSpy.mock.calls[0][0] as string) as { ok: boolean; data: { tasks: Array<{ id: string }> } };
    expect(listPayload.ok).toBe(true);
    expect(listPayload.data.tasks[0].id).toBe('1');

    await teamCommand(['api', 'read-config', '--input', JSON.stringify({ teamName: 'api-team' }), '--json', '--cwd', cwd]);
    const configPayload = JSON.parse(logSpy.mock.calls[1][0] as string) as { ok: boolean; data: { config: { workerCount: number } } };
    expect(configPayload.ok).toBe(true);
    expect(configPayload.data.config.workerCount).toBe(1);

    rmSync(cwd, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('team api returns structured JSON envelope for unsupported operation', async () => {
    const { teamCommand } = await import('../team.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await teamCommand(['api', 'unknown-op', '--json', '--input', JSON.stringify({ teamName: 'demo-team' })]);

    const payload = JSON.parse(logSpy.mock.calls[0][0] as string) as { ok: boolean; error: { code: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_OPERATION');

    logSpy.mockRestore();
  });
});
