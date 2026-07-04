#!/usr/bin/env node
import { existsSync as nodeExistsSync, statSync as nodeStatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const VIEWER_SCOPE = {
  CURRENT_SESSION: 'current-session',
  CURRENT_SESSION_UNAVAILABLE: 'current-session-unavailable',
};

const STATE_KIND = {
  CURRENT_SESSION_UNAVAILABLE: 'current-session-unavailable',
  MISSING_HISTORY: 'missing-history',
  CURRENT_SESSION_HISTORY: 'current-session-history',
  MISSING_SCHEMA: 'missing-schema',
  DATABASE_BUSY: 'database-busy',
  READ_ONLY_UNAVAILABLE: 'read-only-unavailable',
};

const HISTORY_LIMIT = 100;

const SCHEMA_EXISTS_SQL = `
  SELECT name
  FROM sqlite_master
  WHERE type = ? AND name = ?
  LIMIT ?
`;

const SUBAGENT_TASK_COLUMNS = `
  id, cwd, agent, mode, status, task, context, created_at, session_id,
  started_at, ended_at, last_activity_at, last_activity, output_preview,
  prompt, transcript, usage_input, usage_output, usage_cache_read,
  usage_cache_write, usage_cost, usage_context_tokens, usage_turns,
  model, effort, model_source, effort_source, fallback_used,
  error, result, thread_snapshot_json
`;

const CURRENT_SESSION_ROWS_SQL = `
  SELECT ${SUBAGENT_TASK_COLUMNS}
  FROM subagent_tasks
  WHERE cwd = ? AND session_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`;

const CURRENT_SESSION_TASK_SQL = `
  SELECT ${SUBAGENT_TASK_COLUMNS}
  FROM subagent_tasks
  WHERE cwd = ? AND session_id = ? AND id = ?
  LIMIT ?
`;

function readOptionPairs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options.set(key, '');
      continue;
    }
    options.set(key, next);
    index += 1;
  }
  return options;
}

export function parseViewerArgs(argv = []) {
  const options = readOptionPairs(argv);
  const errors = [];
  const cwd = options.get('cwd') ?? '';
  const dbPath = options.get('db') ?? '';
  const scope = options.get('scope') ?? '';
  const sessionId = options.get('session-id') || undefined;
  const refreshValue = Number(options.get('refresh-ms') ?? '1000');
  const refreshMs = Number.isFinite(refreshValue) && refreshValue > 0 ? Math.trunc(refreshValue) : 1000;

  if (!cwd) errors.push('missing --cwd');
  if (!dbPath) errors.push('missing --db');
  if (scope !== VIEWER_SCOPE.CURRENT_SESSION && scope !== VIEWER_SCOPE.CURRENT_SESSION_UNAVAILABLE) {
    errors.push('missing or invalid --scope');
  }
  if (scope === VIEWER_SCOPE.CURRENT_SESSION && !sessionId) {
    errors.push('current-session scope requires --session-id');
  }

  return {
    errors,
    config: { cwd, dbPath, scope, sessionId, refreshMs },
  };
}

function readOnlyUnavailable(config, error) {
  return {
    kind: STATE_KIND.READ_ONLY_UNAVAILABLE,
    config,
    error: error instanceof Error ? error.message : String(error ?? ''),
  };
}

function databaseBusy(config, error) {
  return {
    kind: STATE_KIND.DATABASE_BUSY,
    config,
    error: error instanceof Error ? error.message : String(error ?? ''),
  };
}

function isBusyOrLockedError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return code.includes('BUSY') || code.includes('LOCKED') || message.includes('database is locked') || message.includes('database busy') || message.includes('database is busy');
}

function isRegularFile(file, statSync) {
  try {
    return statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

function resolveDatabaseSync(io) {
  if (io.DatabaseSync) return io.DatabaseSync;
  const sqlite = require('node:sqlite');
  return sqlite.DatabaseSync;
}

function hasExistingSqliteSidecar(dbPath, existsSync) {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].some((file) => existsSync(file));
}

export function readOnlySqliteLocation(dbPath, io = {}) {
  const url = pathToFileURL(dbPath);
  url.searchParams.set('mode', 'ro');
  if (!hasExistingSqliteSidecar(dbPath, io.existsSync ?? nodeExistsSync)) url.searchParams.set('immutable', '1');
  return url.href;
}

function openReadOnlyDatabase(dbPath, io) {
  const DatabaseSync = resolveDatabaseSync(io);
  return new DatabaseSync(readOnlySqliteLocation(dbPath, io), { readOnly: true });
}

function configureReadOnlyConnection(db) {
  db.exec('PRAGMA query_only = ON');
  db.exec('PRAGMA busy_timeout = 500');
}

function hasSubagentTasksTable(db) {
  return db.prepare(SCHEMA_EXISTS_SQL).all('table', 'subagent_tasks', 1).length > 0;
}

export function queryCurrentSessionRows(db, config, limit = HISTORY_LIMIT) {
  return db.prepare(CURRENT_SESSION_ROWS_SQL).all(config.cwd, config.sessionId, limit);
}

export function queryCurrentSessionTaskById(db, config, taskId) {
  const rows = db.prepare(CURRENT_SESSION_TASK_SQL).all(config.cwd, config.sessionId, taskId, 1);
  return rows[0];
}

export function createInitialViewerState(config, io = {}) {
  if (config.scope === VIEWER_SCOPE.CURRENT_SESSION_UNAVAILABLE) {
    return {
      kind: STATE_KIND.CURRENT_SESSION_UNAVAILABLE,
      config,
    };
  }

  const existsSync = io.existsSync ?? nodeExistsSync;
  if (!existsSync(config.dbPath)) {
    return {
      kind: STATE_KIND.MISSING_HISTORY,
      config,
    };
  }

  const statSync = io.statSync ?? nodeStatSync;
  if (!isRegularFile(config.dbPath, statSync)) return readOnlyUnavailable(config, 'History path is not a regular file.');

  let db;
  try {
    db = openReadOnlyDatabase(config.dbPath, io);
    configureReadOnlyConnection(db);
    if (!hasSubagentTasksTable(db)) {
      return {
        kind: STATE_KIND.MISSING_SCHEMA,
        config,
      };
    }

    return {
      kind: STATE_KIND.CURRENT_SESSION_HISTORY,
      config,
      rows: queryCurrentSessionRows(db, config, HISTORY_LIMIT),
    };
  } catch (error) {
    if (isBusyOrLockedError(error)) return databaseBusy(config, error);
    return readOnlyUnavailable(config, error);
  } finally {
    try { db?.close?.(); } catch {}
  }
}

function truncateText(text, maxLength) {
  const chars = [...text];
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

function stripTerminalControls(value) {
  return String(value ?? '')
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()%*+\-.\/][0-~]/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '')
    .replace(/[\u0080-\u009f]/g, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function sanitizeForTerminalInline(value, options = {}) {
  const maxLength = options.maxLength ?? 240;
  return truncateText(stripTerminalControls(value).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim(), maxLength);
}

export function sanitizeForTerminalBlock(value, options = {}) {
  const maxLength = options.maxLength ?? 6000;
  const maxLineLength = options.maxLineLength ?? 240;
  const truncated = truncateText(stripTerminalControls(value), maxLength);
  return truncated
    .split('\n')
    .map((line) => truncateText(line.replace(/\s+$/g, ''), maxLineLength))
    .join('\n')
    .replace(/\n+$/g, '');
}

function safeInline(value, fallback = 'unavailable') {
  const sanitized = sanitizeForTerminalInline(value);
  return sanitized || fallback;
}

function sanitizeStructuredValue(value) {
  if (typeof value === 'string') return sanitizeForTerminalBlock(value);
  if (Array.isArray(value)) return value.map(sanitizeStructuredValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitizeForTerminalInline(key), sanitizeStructuredValue(item)]));
  }
  return value;
}

function safeJson(value) {
  try {
    return JSON.stringify(sanitizeStructuredValue(value));
  } catch {
    return '[unserializable]';
  }
}

function payloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.preview === 'string' && payload.preview) return payload.preview;
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      return typeof part.text === 'string' ? part.text : typeof part.data === 'string' ? part.data : '';
    })
    .filter(Boolean)
    .join('\n');
}

function snapshotItemText(item) {
  if (!item || typeof item !== 'object') return [];
  switch (item.type) {
    case 'assistant': {
      const lines = [];
      const content = Array.isArray(item.message?.content) ? item.message.content : [];
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') lines.push(`assistant: ${part.text}`);
        if (part?.type === 'thinking') lines.push(`thinking: ${part.thinking ?? part.text ?? ''}`);
      }
      if (typeof item.message?.errorMessage === 'string') lines.push(`assistant error: ${item.message.errorMessage}`);
      return lines;
    }
    case 'user':
      return [`${item.label ?? 'user'}: ${item.text ?? ''}`];
    case 'tool': {
      const lines = [`tool ${item.name ?? 'tool'} ${item.status ?? 'unknown'}`];
      if ('arguments' in item) lines.push(`arguments: ${safeJson(item.arguments)}`);
      const result = payloadText(item.result);
      if (result) lines.push(result);
      return lines;
    }
    case 'tool_result': {
      const lines = [`tool result${item.name ? ` ${item.name}` : ''}${item.result?.isError ? ' failed' : ''}`];
      const result = payloadText(item.result);
      if (result) lines.push(result);
      return lines;
    }
    case 'bash': {
      const status = item.cancelled ? 'cancelled' : item.status ?? 'completed';
      return [`bash ${status}: ${item.command ?? ''}`, item.output ?? ''].filter(Boolean);
    }
    case 'custom':
      return [`custom ${item.customType ?? 'message'}${item.fallbackText ? `: ${item.fallbackText}` : ''}`, typeof item.content === 'string' ? item.content : ''].filter(Boolean);
    case 'status':
      return [`${item.severity ?? 'info'}: ${item.text ?? ''}`];
    case 'error':
      return [`error: ${item.text ?? ''}`];
    default:
      return [];
  }
}

function renderThreadSnapshotText(snapshotJson) {
  if (typeof snapshotJson !== 'string' || !snapshotJson.trim()) return '';
  try {
    const snapshot = JSON.parse(snapshotJson);
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.items)) return 'thread snapshot unavailable/corrupt';
    const lines = snapshot.items.flatMap(snapshotItemText).filter(Boolean);
    return lines.length ? lines.join('\n') : 'thread snapshot unavailable';
  } catch {
    return 'thread snapshot unavailable/corrupt';
  }
}

function appendInline(lines, label, value) {
  lines.push(`${label}: ${safeInline(value)}`);
}

function appendBlock(lines, label, value) {
  const sanitized = sanitizeForTerminalBlock(value);
  if (!sanitized) return;
  lines.push(`${label}:`);
  for (const line of sanitized.split('\n')) lines.push(`│ ${line}`);
}

function appendTaskDetail(lines, row) {
  lines.push('Selected task detail:');
  appendInline(lines, 'id', row.id);
  appendInline(lines, 'cwd', row.cwd);
  appendInline(lines, 'session', row.session_id);
  appendInline(lines, 'agent', row.agent);
  appendInline(lines, 'mode', row.mode);
  appendInline(lines, 'status', row.status);
  appendInline(lines, 'model', row.model);
  appendInline(lines, 'effort', row.effort);
  appendInline(lines, 'created', row.created_at);
  appendInline(lines, 'last activity', row.last_activity);
  appendBlock(lines, 'task', row.task);
  appendBlock(lines, 'context', row.context);
  appendBlock(lines, 'prompt', row.prompt);
  appendBlock(lines, 'output preview', row.output_preview);
  appendBlock(lines, 'result', row.result);
  appendBlock(lines, 'error', row.error);
  appendBlock(lines, 'transcript', row.transcript);
  appendBlock(lines, 'thread snapshot', renderThreadSnapshotText(row.thread_snapshot_json));
}

function scopeLabel(config) {
  if (config.scope === VIEWER_SCOPE.CURRENT_SESSION && config.sessionId) return `current session ${safeInline(config.sessionId)}`;
  return 'current session unavailable';
}

export function renderViewerState(state) {
  const lines = [
    'Pi Subagents — read-only persisted history viewer',
    `scope: ${scopeLabel(state.config)}`,
    `cwd: ${safeInline(state.config.cwd)}`,
    'READ-ONLY · persisted history · current session only · prompts/results may be visible in this window',
    '',
  ];

  if (state.kind === STATE_KIND.CURRENT_SESSION_UNAVAILABLE) {
    lines.push(
      'Current Pi session is unavailable.',
      'Fail-closed: persisted history was not queried.',
      'Use /subagents in the main Pi session for in-session viewing.',
    );
    return lines;
  }

  if (state.kind === STATE_KIND.MISSING_HISTORY) {
    lines.push(
      'No subagent history database found yet.',
      'The viewer did not create history files or tables.',
      `Refresh interval: ${state.config.refreshMs}ms`,
    );
    return lines;
  }

  if (state.kind === STATE_KIND.MISSING_SCHEMA) {
    lines.push(
      'No subagent history table found yet.',
      'The viewer did not create or migrate history tables.',
      `Refresh interval: ${state.config.refreshMs}ms`,
    );
    return lines;
  }

  if (state.kind === STATE_KIND.DATABASE_BUSY) {
    lines.push(
      'database busy; retrying',
      'The viewer kept read-only mode and will retry on the next refresh.',
      `Refresh interval: ${state.config.refreshMs}ms`,
    );
    return lines;
  }

  if (state.kind === STATE_KIND.READ_ONLY_UNAVAILABLE) {
    lines.push(
      'Read-only history access is unavailable.',
      'The viewer failed closed without weakening read-only mode.',
      `Refresh interval: ${state.config.refreshMs}ms`,
    );
    return lines;
  }

  const rows = Array.isArray(state.rows) ? state.rows : [];
  lines.push(`database: ok · tasks: ${rows.length}`);
  if (!rows.length) {
    lines.push('No subagent tasks recorded in this current session yet.', `Refresh interval: ${state.config.refreshMs}ms`);
    return lines;
  }

  lines.push('Tasks:');
  for (const [index, row] of rows.entries()) {
    lines.push(`${index + 1}. ${safeInline(row.status)} · ${safeInline(row.agent)} · ${safeInline(row.task)}`);
  }
  lines.push('');
  appendTaskDetail(lines, rows[0]);
  lines.push('', `Refresh interval: ${state.config.refreshMs}ms`);
  return lines;
}

function shouldExitForInput(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  return text === 'q' || text === '\u001b' || text === '\u0003';
}

export function keepInteractiveViewerAlive(io = {}) {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin?.isTTY) return { interactive: false, stop() {} };

  let stopped = false;
  const setRawMode = (enabled) => {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(enabled);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stdin.off?.('data', onData);
    stdin.off?.('close', stop);
    stdin.off?.('end', stop);
    setRawMode(false);
    stdin.pause?.();
  };
  const onData = (chunk) => {
    if (shouldExitForInput(chunk)) stop();
  };

  stdin.on?.('data', onData);
  stdin.once?.('close', stop);
  stdin.once?.('end', stop);
  setRawMode(true);
  stdin.resume?.();

  return { interactive: true, stop };
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const parsed = parseViewerArgs(argv);
  if (parsed.errors.length > 0) {
    stderr.write(`Invalid /subagents-terminal viewer arguments:\n${parsed.errors.map((error) => `- ${error}`).join('\n')}\n`);
    return 2;
  }
  const state = createInitialViewerState(parsed.config, io);
  stdout.write(`${renderViewerState(state).join('\n')}\n`);
  keepInteractiveViewerAlive(io);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli();
}
