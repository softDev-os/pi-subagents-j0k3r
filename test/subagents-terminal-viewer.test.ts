import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string, options?: Record<string, unknown>) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
      get?(...args: unknown[]): unknown;
    };
    close(): void;
  };
};

type HistoryRowFixture = {
  id: string;
  cwd: string;
  session_id: string;
  task: string;
  agent?: string;
  mode?: string;
  status?: string;
  context?: string | null;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  last_activity_at?: string | null;
  last_activity?: string | null;
  output_preview?: string | null;
  prompt?: string | null;
  transcript?: string | null;
  usage_input?: number | null;
  usage_output?: number | null;
  usage_cache_read?: number | null;
  usage_cache_write?: number | null;
  usage_cost?: number | null;
  usage_context_tokens?: number | null;
  usage_turns?: number | null;
  model?: string | null;
  effort?: string | null;
  model_source?: string | null;
  effort_source?: string | null;
  fallback_used?: number | null;
  error?: string | null;
  result?: string | null;
  thread_snapshot_json?: string | null;
};

async function loadViewerModule() {
  return import(pathToFileURL(path.join(process.cwd(), 'bin/subagents-terminal-viewer.mjs')).href);
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = createTempDir(prefix);
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createHistorySchema(db: InstanceType<typeof DatabaseSync>): void {
  db.exec(`
    CREATE TABLE subagent_tasks (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      agent TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      task TEXT NOT NULL,
      context TEXT,
      created_at TEXT NOT NULL,
      session_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      last_activity_at TEXT,
      last_activity TEXT,
      output_preview TEXT,
      prompt TEXT,
      transcript TEXT,
      usage_input INTEGER,
      usage_output INTEGER,
      usage_cache_read INTEGER,
      usage_cache_write INTEGER,
      usage_cost REAL,
      usage_context_tokens INTEGER,
      usage_turns INTEGER,
      model TEXT,
      effort TEXT,
      model_source TEXT,
      effort_source TEXT,
      fallback_used INTEGER,
      error TEXT,
      result TEXT,
      thread_snapshot_json TEXT
    );
  `);
}

function insertHistoryRows(dbPath: string, rows: HistoryRowFixture[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    createHistorySchema(db);
    const statement = db.prepare(`
      INSERT INTO subagent_tasks (
        id, cwd, agent, mode, status, task, context, created_at, session_id, started_at, ended_at,
        last_activity_at, last_activity, output_preview, prompt, transcript,
        usage_input, usage_output, usage_cache_read, usage_cache_write, usage_cost, usage_context_tokens, usage_turns,
        model, effort, model_source, effort_source, fallback_used, error, result, thread_snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      statement.run(
        row.id,
        row.cwd,
        row.agent ?? 'tester',
        row.mode ?? 'task',
        row.status ?? 'completed',
        row.task,
        row.context ?? null,
        row.created_at ?? '2026-07-03T00:00:00.000Z',
        row.session_id,
        row.started_at ?? null,
        row.ended_at ?? null,
        row.last_activity_at ?? null,
        row.last_activity ?? null,
        row.output_preview ?? null,
        row.prompt ?? null,
        row.transcript ?? null,
        row.usage_input ?? null,
        row.usage_output ?? null,
        row.usage_cache_read ?? null,
        row.usage_cache_write ?? null,
        row.usage_cost ?? null,
        row.usage_context_tokens ?? null,
        row.usage_turns ?? null,
        row.model ?? null,
        row.effort ?? null,
        row.model_source ?? null,
        row.effort_source ?? null,
        row.fallback_used ?? null,
        row.error ?? null,
        row.result ?? null,
        row.thread_snapshot_json ?? null,
      );
    }
  } finally {
    db.close();
  }
}

function countHistoryRows(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT COUNT(*) AS total FROM subagent_tasks').all() as Array<{ total: number }>;
    return rows[0]?.total ?? 0;
  } finally {
    db.close();
  }
}

function historyConfig(cwd: string, sessionId: string, dbPath: string) {
  return { cwd, dbPath, scope: 'current-session', sessionId, refreshMs: 1000 };
}

function sortedFiles(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

describe('subagents terminal viewer bootstrap', () => {
  it('parses fail-closed no-session scope and renders without touching history', async () => {
    const viewer = await loadViewerModule();
    const parsed = viewer.parseViewerArgs([
      '--cwd', '/tmp/project with spaces',
      '--db', '/tmp/history.sqlite',
      '--scope', 'current-session-unavailable',
      '--refresh-ms', '1000',
    ]);
    const existsSync = vi.fn(() => { throw new Error('DB existence should not be checked without a session'); });

    const state = viewer.createInitialViewerState(parsed.config, { existsSync });
    const rendered = viewer.renderViewerState(state).join('\n');

    expect(parsed.errors).toEqual([]);
    expect(state.kind).toBe('current-session-unavailable');
    expect(existsSync).not.toHaveBeenCalled();
    expect(rendered).toContain('Current Pi session is unavailable');
    expect(rendered).toContain('persisted history was not queried');
    expect(rendered).toContain('Use /subagents in the main Pi session');
    expect(rendered).toContain('READ-ONLY');
    expect(rendered).not.toContain('cwd-only');
  });

  it('requires session id for current-session scope instead of falling back to cwd history', async () => {
    const viewer = await loadViewerModule();
    const parsed = viewer.parseViewerArgs([
      '--cwd', '/tmp/project',
      '--db', '/tmp/history.sqlite',
      '--scope', 'current-session',
      '--refresh-ms', '1000',
    ]);

    expect(parsed.errors).toContain('current-session scope requires --session-id');
  });

  it('renders a read-only missing-history state without creating the database', async () => {
    const viewer = await loadViewerModule();
    const parsed = viewer.parseViewerArgs([
      '--cwd', '/tmp/project',
      '--db', '/tmp/missing-history.sqlite',
      '--scope', 'current-session',
      '--session-id', 'session-1',
      '--refresh-ms', '1000',
    ]);
    const existsSync = vi.fn(() => false);

    const state = viewer.createInitialViewerState(parsed.config, { existsSync });
    const rendered = viewer.renderViewerState(state).join('\n');

    expect(parsed.errors).toEqual([]);
    expect(existsSync).toHaveBeenCalledWith('/tmp/missing-history.sqlite');
    expect(state.kind).toBe('missing-history');
    expect(rendered).toContain('No subagent history database found yet');
    expect(rendered).toContain('current session session-1');
    expect(rendered).toContain('READ-ONLY');
  });

  it('renders empty current-session history without broadening scope to same-cwd rows', async () => {
    await withTempDir('pi-viewer-empty-session-', async (dir) => {
      const viewer = await loadViewerModule();
      const dbPath = path.join(dir, 'history.sqlite');
      insertHistoryRows(dbPath, [
        { id: 'old-session', cwd: '/tmp/project', session_id: 'session-old', task: 'same cwd old session task' },
      ]);

      const state = viewer.createInitialViewerState(historyConfig('/tmp/project', 'session-current', dbPath));
      const rendered = viewer.renderViewerState(state).join('\n');

      expect(state.kind).toBe('current-session-history');
      expect(state.rows).toEqual([]);
      expect(rendered).toContain('current session session-current');
      expect(rendered).toContain('No subagent tasks recorded in this current session yet');
      expect(rendered).not.toContain('same cwd old session task');
      expect(rendered).not.toContain('cwd-only');
    });
  });

  it('keeps an interactive TTY viewer alive until q, escape, or ctrl+c exits', async () => {
    const viewer = await loadViewerModule();
    const exitInputs = ['q', '\u001b', '\u0003'];
    expect(exitInputs).toHaveLength(3);

    for (const input of exitInputs) {
      const stdoutWrites: string[] = [];
      const stdin = new EventEmitter() as EventEmitter & {
        isTTY: boolean;
        setRawMode: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
        pause: ReturnType<typeof vi.fn>;
      };
      stdin.isTTY = true;
      stdin.setRawMode = vi.fn();
      stdin.resume = vi.fn();
      stdin.pause = vi.fn();

      const exitCode = viewer.runCli([
        '--cwd', '/tmp/project',
        '--db', '/tmp/history.sqlite',
        '--scope', 'current-session-unavailable',
        '--refresh-ms', '1000',
      ], {
        stdin,
        stdout: { write: (text: string) => { stdoutWrites.push(text); return true; } },
        stderr: { write: vi.fn() },
      });

      expect(exitCode).toBe(0);
      expect(stdoutWrites.join('')).toContain('Pi Subagents');
      expect(stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(stdin.resume).toHaveBeenCalledTimes(1);
      expect(stdin.listenerCount('data')).toBe(1);

      stdin.emit('data', Buffer.from(input));

      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(stdin.pause).toHaveBeenCalledTimes(1);
      expect(stdin.listenerCount('data')).toBe(0);
    }
  });

  it('does not exit for arrow, page, home, or end escape sequences', async () => {
    const viewer = await loadViewerModule();
    const navigationInputs = ['\u001b[A', '\u001b[B', '\u001b[5~', '\u001b[6~', '\u001b[H', '\u001b[F'];
    expect(navigationInputs).toHaveLength(6);

    for (const input of navigationInputs) {
      const stdin = new EventEmitter() as EventEmitter & {
        isTTY: boolean;
        setRawMode: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
        pause: ReturnType<typeof vi.fn>;
      };
      stdin.isTTY = true;
      stdin.setRawMode = vi.fn();
      stdin.resume = vi.fn();
      stdin.pause = vi.fn();

      const keepalive = viewer.keepInteractiveViewerAlive({ stdin });
      expect(keepalive.interactive).toBe(true);
      expect(stdin.listenerCount('data')).toBe(1);

      stdin.emit('data', Buffer.from(input));

      expect(stdin.listenerCount('data')).toBe(1);
      expect(stdin.pause).not.toHaveBeenCalled();
      expect(stdin.setRawMode).not.toHaveBeenLastCalledWith(false);

      stdin.emit('data', Buffer.from('\u001b'));

      expect(stdin.listenerCount('data')).toBe(0);
      expect(stdin.pause).toHaveBeenCalledTimes(1);
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    }
  });

  it('cleans up interactive keepalive when stdin closes', async () => {
    const viewer = await loadViewerModule();
    const stdin = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    stdin.isTTY = true;
    stdin.setRawMode = vi.fn();
    stdin.resume = vi.fn();
    stdin.pause = vi.fn();

    const exitCode = viewer.runCli([
      '--cwd', '/tmp/project',
      '--db', '/tmp/history.sqlite',
      '--scope', 'current-session-unavailable',
    ], {
      stdin,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(stdin.listenerCount('close')).toBe(1);

    stdin.emit('close');

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalledTimes(1);
    expect(stdin.listenerCount('close')).toBe(0);
  });

  it('opens existing history read-only and filters rows by both cwd and current session without sidecar writes', async () => {
    await withTempDir('pi-viewer-current-session-', async (dir) => {
      const viewer = await loadViewerModule();
      const dbPath = path.join(dir, 'history.sqlite');
      const currentCwd = "/tmp/project 'quoted'; --";
      const currentSession = "session 'current'; --";
      insertHistoryRows(dbPath, [
        { id: 'match', cwd: currentCwd, session_id: currentSession, task: 'matching current-session task', created_at: '2026-07-03T03:00:00.000Z' },
        { id: 'old-session', cwd: currentCwd, session_id: 'session-old', task: 'same cwd old session task', created_at: '2026-07-03T02:00:00.000Z' },
        { id: 'other-cwd', cwd: '/tmp/other', session_id: currentSession, task: 'other cwd same session task', created_at: '2026-07-03T01:00:00.000Z' },
      ]);
      const beforeFiles = sortedFiles(dir);
      expect(viewer.readOnlySqliteLocation(dbPath)).toContain('immutable=1');

      const state = viewer.createInitialViewerState(historyConfig(currentCwd, currentSession, dbPath));
      const rendered = viewer.renderViewerState(state).join('\n');

      expect(state.kind).toBe('current-session-history');
      expect(state.rows.map((row: { id: string }) => row.id)).toEqual(['match']);
      expect(rendered).toContain('matching current-session task');
      expect(rendered).not.toContain('same cwd old session task');
      expect(rendered).not.toContain('other cwd same session task');
      expect(countHistoryRows(dbPath)).toBe(3);
      expect(sortedFiles(dir)).toEqual(beforeFiles);
    });
  });

  it('uses a read-only SQLite location and bound parameters for dynamic values', async () => {
    const viewer = await loadViewerModule();
    const maliciousCwd = "/tmp/project'; DROP TABLE subagent_tasks; --";
    const maliciousSession = "session' OR '1'='1";
    const constructorCalls: Array<{ location: string; options: Record<string, unknown> | undefined }> = [];
    const prepared: Array<{ sql: string; args: unknown[] }> = [];
    class FakeDatabaseSync {
      constructor(location: string, options?: Record<string, unknown>) {
        constructorCalls.push({ location, options });
      }
      exec(sql: string) {
        prepared.push({ sql, args: [] });
      }
      prepare(sql: string) {
        const entry = { sql, args: [] as unknown[] };
        prepared.push(entry);
        return {
          all: (...args: unknown[]) => {
            entry.args = args;
            if (sql.includes('sqlite_master')) return [{ name: 'subagent_tasks' }];
            return [];
          },
        };
      }
      close() {}
    }

    const state = viewer.createInitialViewerState(historyConfig(maliciousCwd, maliciousSession, '/tmp/history.sqlite'), {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
      DatabaseSync: FakeDatabaseSync,
    });

    expect(state.kind).toBe('current-session-history');
    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.location).toMatch(/^file:/);
    expect(constructorCalls[0]?.location).toContain('mode=ro');
    expect(constructorCalls[0]?.location).not.toContain('immutable=1');
    expect(constructorCalls[0]?.options).toMatchObject({ readOnly: true });
    expect(prepared.some((entry) => entry.sql === 'PRAGMA query_only = ON')).toBe(true);
    expect(prepared.some((entry) => entry.sql === 'PRAGMA busy_timeout = 500')).toBe(true);

    const sqlText = prepared.map((entry) => entry.sql).join('\n');
    expect(sqlText).toContain('WHERE cwd = ? AND session_id = ?');
    expect(sqlText).not.toContain(maliciousCwd);
    expect(sqlText).not.toContain(maliciousSession);
    expect(prepared.find((entry) => entry.sql.includes('sqlite_master'))?.args).toEqual(['table', 'subagent_tasks', 1]);
    expect(prepared.find((entry) => entry.sql.includes('FROM subagent_tasks'))?.args).toEqual([maliciousCwd, maliciousSession, 100]);
  });

  it('reads live WAL-mode history without adding viewer-created sidecar files', async () => {
    await withTempDir('pi-viewer-wal-sidecars-', async (dir) => {
      const viewer = await loadViewerModule();
      const dbPath = path.join(dir, 'history.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('PRAGMA journal_mode = WAL');
        createHistorySchema(db);
        db.prepare('INSERT INTO subagent_tasks (id, cwd, agent, mode, status, task, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run('wal-match', '/tmp/project', 'tester', 'task', 'completed', 'wal current task', '2026-07-03T00:00:00.000Z', 'session-1');

        const beforeFiles = sortedFiles(dir);
        expect(beforeFiles).toEqual(['history.sqlite', 'history.sqlite-shm', 'history.sqlite-wal']);

        const state = viewer.createInitialViewerState(historyConfig('/tmp/project', 'session-1', dbPath));

        expect(state.kind).toBe('current-session-history');
        expect(state.rows.map((row: { id: string }) => row.id)).toEqual(['wal-match']);
        expect(sortedFiles(dir)).toEqual(beforeFiles);
      } finally {
        db.close();
      }
    });
  });

  it('reports missing schema without creating or migrating history tables', async () => {
    await withTempDir('pi-viewer-missing-schema-', async (dir) => {
      const viewer = await loadViewerModule();
      const dbPath = path.join(dir, 'history.sqlite');
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
      } finally {
        db.close();
      }

      const state = viewer.createInitialViewerState(historyConfig('/tmp/project', 'session-1', dbPath));
      const rendered = viewer.renderViewerState(state).join('\n');
      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const tables = verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toEqual(['unrelated']);
      } finally {
        verifyDb.close();
      }

      expect(state.kind).toBe('missing-schema');
      expect(rendered).toContain('No subagent history table found yet');
      expect(rendered).not.toContain('CREATE TABLE');
    });
  });

  it('surfaces busy or locked SQLite reads as retryable viewer state', async () => {
    const viewer = await loadViewerModule();
    const busyError = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    class BusyDatabaseSync {
      exec() {}
      prepare(sql: string) {
        return {
          all: (..._args: unknown[]) => {
            if (sql.includes('sqlite_master')) return [{ name: 'subagent_tasks' }];
            throw busyError;
          },
        };
      }
      close() {}
    }

    const state = viewer.createInitialViewerState(historyConfig('/tmp/project', 'session-1', '/tmp/history.sqlite'), {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
      DatabaseSync: BusyDatabaseSync,
    });
    const rendered = viewer.renderViewerState(state).join('\n');

    expect(state.kind).toBe('database-busy');
    expect(rendered).toContain('database busy; retrying');
  });

  it('fails closed when read-only SQLite access is unavailable and never retries writable mode', async () => {
    const viewer = await loadViewerModule();
    const constructorCalls: Array<{ options: Record<string, unknown> | undefined }> = [];
    class ReadOnlyUnavailableDatabaseSync {
      constructor(_location: string, options?: Record<string, unknown>) {
        constructorCalls.push({ options });
        throw new Error('read-only open unavailable');
      }
    }

    const state = viewer.createInitialViewerState(historyConfig('/tmp/project', 'session-1', '/tmp/history.sqlite'), {
      existsSync: () => true,
      statSync: () => ({ isFile: () => true }),
      DatabaseSync: ReadOnlyUnavailableDatabaseSync,
    });
    const rendered = viewer.renderViewerState(state).join('\n');

    expect(constructorCalls).toEqual([{ options: { readOnly: true } }]);
    expect(state.kind).toBe('read-only-unavailable');
    expect(rendered).toContain('Read-only history access is unavailable');
    expect(rendered).not.toContain('writable');
  });

  it('does not import history writers, manager, tools, thread view, or other src modules in the external viewer', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin/subagents-terminal-viewer.mjs'), 'utf8');

    expect(source).not.toMatch(/from ['"].*src\/(history|manager|tools|thread-view)\.js['"]/);
    expect(source).not.toMatch(/import\(['"].*src\/(history|manager|tools|thread-view)\.js['"]\)/);
    expect(source).not.toContain('SubagentManager');
    expect(source).not.toContain('registerSubagentTools');
    expect(source).not.toContain('SubagentHistoryStore');
  });

  it('sanitizes persisted terminal control sequences across all rendered untrusted fields', async () => {
    await withTempDir('pi-viewer-sanitizer-', async (dir) => {
      const viewer = await loadViewerModule();
      const dbPath = path.join(dir, 'history.sqlite');
      const malicious = [
        'visible text',
        '\u001b]52;c;SECRET_CLIPBOARD\u0007',
        '\u001b]0;BAD_TITLE\u0007',
        '\u001b]8;;https://evil.example\u0007evil link\u001b]8;;\u0007',
        '\u001b[2J\u001b[H\u001b[?25l\u001b[31m',
        '\u001bPqDCS_PAYLOAD\u001b\\',
        'line\rspoof\btext',
        '\u009b31mC1_PAYLOAD',
        '\nFAKE TRUSTED HEADER\n',
      ].join(' ');
      const cwd = `/tmp/project ${malicious}`;
      const sessionId = `session ${malicious}`;
      const snapshot = {
        version: 1,
        source: 'events',
        items: [
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `assistant ${malicious}` }] } },
          { type: 'user', label: 'prompt', text: `user ${malicious}` },
          { type: 'tool', name: `read ${malicious}`, status: 'completed', arguments: { path: `file ${malicious}` }, result: { isError: false, content: [{ type: 'text', text: `tool output ${malicious}` }] } },
          { type: 'tool_result', name: `grep ${malicious}`, result: { isError: true, content: [{ type: 'text', text: `tool result ${malicious}` }] } },
          { type: 'bash', command: `echo ${malicious}`, output: `bash output ${malicious}`, status: 'completed', exitCode: 0 },
          { type: 'custom', customType: `custom ${malicious}`, fallbackText: `custom output ${malicious}` },
          { type: 'status', severity: 'info', text: `status ${malicious}` },
          { type: 'error', text: `snapshot error ${malicious}` },
        ],
      };
      insertHistoryRows(dbPath, [{
        id: `id ${malicious}`,
        cwd,
        session_id: sessionId,
        task: `task ${malicious}`,
        agent: `agent ${malicious}`,
        status: `status ${malicious}`,
        context: `context ${malicious}`,
        last_activity: `activity ${malicious}`,
        output_preview: `preview ${malicious}`,
        prompt: `prompt ${malicious}`,
        transcript: `transcript ${malicious}`,
        model: `model ${malicious}`,
        effort: `effort ${malicious}`,
        error: `error ${malicious}`,
        result: `result ${malicious}`,
        thread_snapshot_json: JSON.stringify(snapshot),
      }]);

      const state = viewer.createInitialViewerState(historyConfig(cwd, sessionId, dbPath));
      const rendered = viewer.renderViewerState(state).join('\n');

      expect(rendered).toContain('visible text');
      expect(rendered).toContain('tool output');
      expect(rendered).toContain('bash output');
      expect(rendered).not.toContain('\u001b');
      expect(rendered).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
      expect(rendered).not.toContain('SECRET_CLIPBOARD');
      expect(rendered).not.toContain('BAD_TITLE');
      expect(rendered).not.toContain('DCS_PAYLOAD');
      expect(rendered.split('\n')).not.toContain('FAKE TRUSTED HEADER');
      expect(rendered).toContain('│ FAKE TRUSTED HEADER');
    });
  });
});
