// ============================================================================
// AGI OS - Terminal Executor (real)
// ----------------------------------------------------------------------------
// The previous implementation never ran anything. It checked two string lists
// and then returned:
//
//     { exitCode: 0, stdout: `Executed: ${command}` }
//
// That is the most dangerous kind of lie in an autonomous system: an agent that
// asks "run the test suite" receives exit code 0 and concludes the suite passed.
// Every downstream decision — commit, deploy, report success — is then built on
// a fabrication.
//
// This version actually executes, and it does so without a shell:
//
//   * `execFile` with an argv array, never `exec` with a command string. There
//     is no shell in the loop, so `;`, `|`, `$()` and backticks cannot compose
//     new commands — and because they cannot, they are rejected outright rather
//     than silently passed as literal arguments that would surprise the caller.
//   * The binary must be a bare name on the allowlist. Path-qualified programs
//     (`/tmp/evil/ls`) are refused, because a basename comparison would let them
//     through and `execFile` would then run whatever is at that path.
//   * The working directory must resolve inside the jail.
//   * The child gets an allowlisted environment, never the host's, so a spawned
//     program cannot read API keys out of `process.env`.
//   * Output is capped, the timeout has a SIGKILL backstop, and truncation is
//     reported instead of being silently dropped.
//
// Failure is reported as failure: a missing binary yields the real ENOENT and a
// non-zero exit, a timeout yields exit 124 with `timedOut: true`, and a refusal
// by policy or by the allowlist yields `refused` with the reason. Nothing here
// returns success unless the child process exited zero.
// ============================================================================

import { execFile } from 'node:child_process';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { generateId } from '@agi-os/kernel';
import {
  GovernanceGateway,
  PolicyDecision,
  matchesDangerousCommand,
} from '@agi-os/governance';
import type { TerminalResult, TerminalExecOptions, TerminalRefusal } from './types.js';

/** 124 is what GNU timeout uses; keeping it makes exit codes legible. */
const EXIT_TIMEOUT = 124;
/** What a refused (never-spawned) command reports. */
const EXIT_REFUSED = 126;
/** Shell convention for "command not found" — a spawn that never started. */
const EXIT_NOT_FOUND = 127;

/**
 * Spawn failures that describe the host, not the command.
 *
 * Under process pressure — a CI runner executing several test files in parallel,
 * each spawning children — `fork` can fail with EAGAIN even though the command
 * is perfectly runnable. Reporting that as "the command failed" is a lie about
 * the program, and it makes the suite red for reasons that have nothing to do
 * with the code under test. These are retried a bounded number of times.
 *
 * ENOENT is deliberately absent: a missing binary is a permanent fact about the
 * command and must be reported immediately as 127.
 */
const TRANSIENT_SPAWN_ERRNOS = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY']);

/**
 * Whether a spawn errno describes the host rather than the command.
 *
 * Exported because the retry policy is worth testing directly: inducing EAGAIN
 * portably is not practical, and a classification that wrongly included ENOENT
 * would turn a missing binary into four pointless attempts.
 */
export function isTransientSpawnError(errno: string | null | undefined): boolean {
  return typeof errno === 'string' && TRANSIENT_SPAWN_ERRNOS.has(errno);
}

/** Attempts for a transient spawn failure, with a short linear backoff. */
const DEFAULT_SPAWN_ATTEMPTS = 4;
const SPAWN_RETRY_DELAY_MS = 120;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT = 200;

/**
 * Binaries an agent may run by default. Deliberately unexciting: read-only
 * inspection plus the toolchain. Anything that mutates the system outside the
 * workspace (package managers installing globally, shells, privilege changes)
 * is absent on purpose and must be added explicitly by an operator.
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'ls', 'cat', 'echo', 'pwd', 'date', 'wc', 'grep', 'head', 'tail', 'find',
  'git', 'node', 'npm', 'pnpm', 'which', 'env', 'sort', 'uniq', 'diff', 'stat',
  'du', 'df', 'tree', 'sed', 'awk', 'cut', 'tr', 'basename', 'dirname', 'realpath',
];

/**
 * Characters that mean "the caller wanted shell composition" when they appear
 * outside quotes. With no shell in the loop these would be inert literal
 * arguments, which is worse than an error: `rm -rf / ; echo done` would try to
 * delete a file literally named ";". Rejecting them makes the contract explicit.
 *
 * The scan happens inside the tokenizer, which knows the quoting state, so a
 * quoted occurrence stays an ordinary character: `node -e "a();b()"` is a
 * legitimate argument, while `echo a;b` is not.
 */
const SINGLE_CHAR_OPERATORS = [';', '|', '&', '`', '>', '<', '\n', '\r'] as const;

/**
 * Environment the child is allowed to inherit. A spawned program otherwise sees
 * every secret in the host process environment.
 */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ'] as const;

// ---------------------------------------------------------------------------
// Tokenisation — shell-like splitting with quotes, and no expansion of any kind
// ---------------------------------------------------------------------------

/**
 * Split a command line into argv the way a shell would split it, minus every
 * form of expansion. Handles single quotes (literal), double quotes (literal —
 * no variable expansion, because there is no shell to expand them) and
 * backslash escapes outside single quotes.
 *
 * Throws on unbalanced quotes: a truncated command line is a bug in the caller,
 * and guessing where the quote closed would be worse than refusing.
 */
/**
 * Thrown when a shell composition operator appears outside quotes.
 *
 * The distinction matters: `echo "a;b"` passes `a;b` as one literal argument,
 * which is harmless because there is no shell to interpret it, while `echo a;b`
 * is a composition attempt that would silently become a stray argument. Only the
 * unquoted form is refused — scanning the raw command string rejects legitimate
 * quoted arguments such as `node -e "a();b()"`.
 */
export class ShellOperatorError extends Error {
  readonly operator: string;

  constructor(operator: string) {
    super(
      `shell operator "${operator === '\n' ? '\\n' : operator === '\r' ? '\\r' : operator}" is not supported: ` +
      'commands run without a shell, so nothing would be piped, redirected or chained. ' +
      'Quote it to pass it as a literal argument, or split the work into separate calls.'
    );
    this.name = 'ShellOperatorError';
    this.operator = operator;
  }
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === '\\' && !inSingle) {
      const next = input[i + 1];
      if (next === undefined) throw new Error('command ends with a dangling backslash escape');
      current += next;
      started = true;
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      started = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      started = true;
      continue;
    }

    // Unquoted shell composition. Quoted occurrences are ordinary characters.
    if (!inSingle && !inDouble) {
      if (ch === '$' && input[i + 1] === '(') throw new ShellOperatorError('$(');
      if ((SINGLE_CHAR_OPERATORS as readonly string[]).includes(ch)) throw new ShellOperatorError(ch);
    }

    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += ch;
    started = true;
  }

  if (inSingle || inDouble) {
    throw new Error(`unbalanced ${inSingle ? 'single' : 'double'} quote in command line`);
  }
  if (started) tokens.push(current);
  return tokens;
}

/** True when `candidate` is inside `root`, compared with a separator boundary. */
function isContainedIn(root: string, candidate: string): boolean {
  const resolvedRoot = resolvePath(root);
  const resolved = resolvePath(candidate);
  if (resolved === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return resolved.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// TerminalExecutor
// ---------------------------------------------------------------------------

export interface TerminalExecutorParams {
  /** Bare binary names permitted to run. Path-qualified programs are refused. */
  allowed?: readonly string[];
  /** Command substrings refused before anything else is considered. */
  blocked?: readonly string[];
  /** Working directories must resolve inside this root. Defaults to cwd. */
  rootDir?: string;
  /** Per-command CPU budget. */
  timeoutMs?: number;
  /** Cap on captured stdout+stderr, per stream. */
  maxBufferBytes?: number;
  /** Bound on retained history, so a long-lived executor cannot grow forever. */
  historyLimit?: number;
  /**
   * Attempts allowed when a spawn fails with a transient host errno (EAGAIN and
   * friends). Set to 1 to disable retrying.
   */
  spawnAttempts?: number;
  /** Governance gateway; a real one is created if omitted. */
  governance?: GovernanceGateway;
  /** Extra environment variables, added to the allowlisted base. */
  env?: Record<string, string>;
}

export class TerminalExecutor {
  private readonly history: TerminalResult[] = [];
  private readonly allowedCommands: string[];
  private readonly blockedCommands: string[];
  private readonly rootDir: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly historyLimit: number;
  private readonly spawnAttempts: number;
  private readonly governance: GovernanceGateway;
  private readonly baseEnv: Record<string, string>;

  constructor(params: TerminalExecutorParams = {}) {
    this.allowedCommands = [...(params.allowed ?? DEFAULT_ALLOWED_COMMANDS)];
    this.blockedCommands = [...(params.blocked ?? [])];
    this.rootDir = resolvePath(params.rootDir ?? process.cwd());
    this.timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBufferBytes = params.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.historyLimit = Math.max(1, params.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.spawnAttempts = Math.max(1, params.spawnAttempts ?? DEFAULT_SPAWN_ATTEMPTS);
    this.governance = params.governance ?? new GovernanceGateway({ workspaceRoots: [this.rootDir] });
    this.baseEnv = this.buildEnv(params.env);
  }

  /** Environment the child will see: allowlisted host vars plus explicit ones. */
  private buildEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (typeof value === 'string') env[key] = value;
    }
    return { ...env, ...extra };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Run a command line for real.
   *
   * No shell is involved: the line is tokenised into argv and handed to
   * `execFile`. Shell composition operators are rejected rather than ignored.
   */
  async execute(command: string, options: TerminalExecOptions = {}): Promise<TerminalResult> {
    const startedAt = Date.now();

    if (typeof command !== 'string' || command.trim().length === 0) {
      return this.record(this.refuse(command, 'empty command', 'EMPTY_COMMAND', startedAt));
    }

    // 1. Explicit blocklist, then the shared dangerous-command screen so this
    //    executor and governance cannot drift apart.
    for (const blocked of this.blockedCommands) {
      if (command.includes(blocked)) {
        return this.record(this.refuse(command, `blocked substring: ${blocked}`, 'BLOCKED_SUBSTRING', startedAt));
      }
    }
    if (matchesDangerousCommand(command)) {
      return this.record(this.refuse(command, 'command matches a known destructive operation', 'DANGEROUS_COMMAND', startedAt));
    }

    // 2. Tokenise.
    let argv: string[];
    try {
      argv = tokenize(command);
    } catch (err) {
      const code = err instanceof ShellOperatorError ? 'SHELL_OPERATOR' : 'MALFORMED_COMMAND';
      return this.record(
        this.refuse(command, err instanceof Error ? err.message : String(err), code, startedAt)
      );
    }
    if (argv.length === 0) {
      return this.record(this.refuse(command, 'command produced no arguments', 'MALFORMED_COMMAND', startedAt));
    }

    // 3. Shell composition is rejected by the tokenizer, which knows whether a
    //    metacharacter was quoted. See ShellOperatorError.

    // 4. Allowlist.
    //
    //    The check must be on the exact argv[0], not on its basename. Comparing
    //    basenames looks stricter but is a bypass: `/tmp/evil/ls` has basename
    //    `ls`, passes the allowlist, and `execFile` then runs the attacker's
    //    binary at the full path. So any path-qualified program is refused
    //    outright — bare names only, resolved through the allowlisted PATH.
    if (argv[0].includes('/') || argv[0].includes('\\')) {
      return this.record(
        this.refuse(
          command,
          `path-qualified binary "${argv[0]}" is not permitted: a basename allowlist cannot ` +
          'verify it, so pass a bare command name resolved through PATH',
          'PATH_QUALIFIED_BINARY',
          startedAt
        )
      );
    }
    const binary = argv[0];
    if (!this.allowedCommands.includes(binary)) {
      return this.record(
        this.refuse(command, `binary "${binary}" is not on the allowlist`, 'NOT_ALLOWED', startedAt)
      );
    }

    // 5. Working directory jail.
    const requestedCwd = options.cwd ?? this.rootDir;
    const cwd = isAbsolute(requestedCwd) ? resolvePath(requestedCwd) : resolvePath(this.rootDir, requestedCwd);
    if (!isContainedIn(this.rootDir, cwd)) {
      return this.record(
        this.refuse(
          command,
          `cwd "${cwd}" is outside the jail "${this.rootDir}"`,
          'CWD_OUTSIDE_JAIL',
          startedAt
        )
      );
    }

    // 6. Governance. The payload vouches for constraints this method has just
    //    actually enforced, which is what makes POL-010's ALLOW meaningful.
    const gate = this.governance.intercept({
      id: generateId(),
      module: 'exec',
      operation: 'execute',
      target: command,
      payload: { allowlisted: true, jailed: true, binary, cwd },
      metadata: { argv, source: 'TerminalExecutor' },
    });

    if (gate.decision === PolicyDecision.BLOCK) {
      return this.record(
        this.refuse(
          command,
          `blocked by governance: ${gate.riskAssessment.reason}`,
          'GOVERNANCE_BLOCKED',
          startedAt,
          gate.auditRecord?.matchedRuleId ?? null,
          undefined,
          gate.decision
        )
      );
    }
    if (gate.decision === PolicyDecision.REQUIRE_APPROVAL) {
      return this.record(
        this.refuse(
          command,
          `governance requires approval: ${gate.riskAssessment.reason}`,
          'GOVERNANCE_APPROVAL_REQUIRED',
          startedAt,
          gate.auditRecord?.matchedRuleId ?? null,
          gate.approvalRequest?.id,
          gate.decision
        )
      );
    }

    // 7. Actually run it.
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.timeoutMs);
    const maxBuffer = Math.max(1024, options.maxBufferBytes ?? this.maxBufferBytes);
    const env = options.env ? { ...this.baseEnv, ...options.env } : this.baseEnv;

    const spawnOpts = { cwd, env, timeoutMs, maxBuffer, stdin: options.stdin };
    let run = await this.spawn(argv[0], argv.slice(1), spawnOpts);

    // A transient host failure is not the command's fault, so retry it a bounded
    // number of times with a linear backoff. Anything permanent — a missing
    // binary, a timeout, a real non-zero exit — is reported on the first pass.
    for (
      let attempt = 2;
      attempt <= this.spawnAttempts && isTransientSpawnError(run.errno);
      attempt++
    ) {
      await delay(SPAWN_RETRY_DELAY_MS * (attempt - 1));
      run = await this.spawn(argv[0], argv.slice(1), spawnOpts);
    }

    // If the host never let the child start, say that plainly instead of
    // presenting a bare errno as though the program had run and failed.
    const exhausted = isTransientSpawnError(run.errno);
    const stderr = exhausted
      ? (run.stderr || 'spawn failed with ' + run.errno) +
        ' (host could not start a child process after ' + this.spawnAttempts + ' attempts)'
      : run.stderr;

    return this.record({
      command,
      argv,
      binary,
      cwd,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr,
      duration: Date.now() - startedAt,
      timedOut: run.timedOut,
      killed: run.killed,
      signal: run.signal,
      truncated: run.truncated,
      governanceDecision: gate.decision,
      matchedRuleId: gate.auditRecord?.matchedRuleId ?? null,
    });
  }

  /**
   * The safe primitive: run a binary with an explicit argv. Prefer this over
   * `execute` when the caller already has structured arguments, because it skips
   * tokenisation entirely and so cannot be surprised by quoting.
   */
  async executeFile(
    binary: string,
    args: readonly string[] = [],
    options: TerminalExecOptions = {}
  ): Promise<TerminalResult> {
    // Reuse every guard by rebuilding the equivalent command line, but quote
    // arguments so tokenisation round-trips them exactly.
    const quoted = [binary, ...args].map((a) => (needsQuoting(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a));
    return this.execute(quoted.join(' '), options);
  }

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------
  private spawn(
    file: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBuffer: number; stdin?: string }
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    killed: boolean;
    signal?: string;
    truncated: boolean;
    /** The spawn errno when the process never started, else null. */
    errno: string | null;
  }> {
    return new Promise((resolvePromise) => {
      let settled = false;
      let truncated = false;

      const child = execFile(
        file,
        args,
        {
          cwd: opts.cwd,
          env: opts.env,
          timeout: opts.timeoutMs,
          maxBuffer: opts.maxBuffer,
          // SIGKILL: a child that ignores SIGTERM would otherwise outlive its budget.
          killSignal: 'SIGKILL',
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          if (settled) return;
          settled = true;

          // With the default utf8 encoding Node types these as string; coerce
          // defensively rather than branching on a type that cannot occur.
          const out = String(stdout ?? '');
          const err = String(stderr ?? '');

          if (!error) {
            resolvePromise({ exitCode: 0, stdout: out, stderr: err, timedOut: false, killed: false, truncated, errno: null });
            return;
          }

          const anyErr = error as NodeJS.ErrnoException & {
            code?: number | string;
            signal?: string;
            killed?: boolean;
          };

          // maxBuffer exceeded: Node reports ENOBUFS and kills the child. Say so
          // rather than presenting partial output as complete.
          if (anyErr.code === 'ENOBUFS' || /maxBuffer/.test(error.message)) {
            truncated = true;
            resolvePromise({
              exitCode: typeof anyErr.code === 'number' ? anyErr.code : 1,
              stdout: out,
              stderr: err || `output exceeded the ${opts.maxBuffer} byte cap and was truncated`,
              timedOut: false,
              killed: true,
              signal: anyErr.signal,
              truncated,
              errno: null,
            });
            return;
          }

          const timedOut = /ETIMEDOUT/i.test(String(anyErr.code)) ||
            error.message.includes('timed out') ||
            (anyErr.killed === true && anyErr.signal === 'SIGKILL' && typeof anyErr.code !== 'number');

          if (timedOut) {
            resolvePromise({
              exitCode: EXIT_TIMEOUT,
              stdout: out,
              stderr: err || `command timed out after ${opts.timeoutMs}ms and was killed`,
              timedOut: true,
              killed: true,
              signal: anyErr.signal ?? 'SIGKILL',
              truncated,
              errno: null,
            });
            return;
          }

          // A spawn failure is not a program exit: the process never ran. Report
          // it with the shell's conventional codes so callers can tell "missing
          // binary" (127) and "not executable" (126) apart from "ran and failed".
          const spawnCode = typeof anyErr.code === 'string' ? anyErr.code : null;
          const notFound = spawnCode === 'ENOENT';
          const notExecutable = spawnCode === 'EACCES' || spawnCode === 'EPERM';

          resolvePromise({
            exitCode: notFound
              ? EXIT_NOT_FOUND
              : notExecutable
                ? EXIT_REFUSED
                : typeof anyErr.code === 'number'
                  ? anyErr.code
                  : 1,
            stdout: out,
            // A missing binary must read as a missing binary, not as an empty run.
            stderr: err || error.message,
            timedOut: false,
            killed: anyErr.killed === true,
            signal: anyErr.signal,
            truncated,
            errno: spawnCode,
          });
        }
      );

      if (opts.stdin !== undefined) {
        child.stdin?.on('error', () => {
          /* EPIPE when the child exits before reading — the callback reports it */
        });
        child.stdin?.end(opts.stdin);
      } else {
        // Close stdin so a child that waits for input fails fast instead of
        // hanging until the timeout.
        child.stdin?.end();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Results and history
  // -------------------------------------------------------------------------

  private refuse(
    command: string,
    reason: string,
    code: TerminalRefusal['code'],
    startedAt: number,
    ruleId: string | null = null,
    approvalRequestId?: string,
    decision: PolicyDecision | null = null
  ): TerminalResult {
    return {
      command: typeof command === 'string' ? command : String(command ?? ''),
      argv: [],
      binary: null,
      cwd: null,
      exitCode: EXIT_REFUSED,
      stdout: '',
      stderr: `refused: ${reason}`,
      duration: Date.now() - startedAt,
      timedOut: false,
      killed: false,
      truncated: false,
      governanceDecision: decision,
      matchedRuleId: ruleId,
      refused: { code, reason, approvalRequestId },
    };
  }

  /** Bounded retention: a long-lived executor must not accumulate without limit. */
  private record(result: TerminalResult): TerminalResult {
    this.history.push(result);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    return result;
  }

  getHistory(): TerminalResult[] {
    return [...this.history];
  }

  /** Only results where a child process actually ran and exited zero. */
  getSuccessful(): TerminalResult[] {
    return this.history.filter((r) => !r.refused && r.exitCode === 0);
  }

  /** Attempts permitted for a transient spawn failure. Clamped to at least 1. */
  getSpawnAttempts(): number {
    return this.spawnAttempts;
  }

  getAllowedCommands(): string[] {
    return [...this.allowedCommands];
  }

  getBlockedCommands(): string[] {
    return [...this.blockedCommands];
  }

  getRootDir(): string {
    return this.rootDir;
  }

  clearHistory(): void {
    this.history.length = 0;
  }
}

/** Does this argument need quoting to survive tokenisation unchanged? */
function needsQuoting(arg: string): boolean {
  return arg.length === 0 || /[\s'"\\]/.test(arg);
}
