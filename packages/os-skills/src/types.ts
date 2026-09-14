export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  permissions?: string;
}

/** Why a command never reached a child process. */
export interface TerminalRefusal {
  code:
    | 'EMPTY_COMMAND'
    | 'BLOCKED_SUBSTRING'
    | 'DANGEROUS_COMMAND'
    | 'MALFORMED_COMMAND'
    | 'SHELL_OPERATOR'
    | 'PATH_QUALIFIED_BINARY'
    | 'NOT_ALLOWED'
    | 'CWD_OUTSIDE_JAIL'
    | 'GOVERNANCE_BLOCKED'
    | 'GOVERNANCE_APPROVAL_REQUIRED';
  reason: string;
  /** Set when governance queued an approval the caller can act on. */
  approvalRequestId?: string;
}

export interface TerminalExecOptions {
  /** Must resolve inside the executor's jail. Defaults to the jail root. */
  cwd?: string;
  /** Overrides the executor-wide CPU budget for this call. */
  timeoutMs?: number;
  /** Overrides the per-stream output cap for this call. */
  maxBufferBytes?: number;
  /** Written to the child's stdin, then closed. */
  stdin?: string;
  /** Added to the allowlisted base environment. Never replaces it wholesale. */
  env?: Record<string, string>;
}

/**
 * The outcome of a real execution.
 *
 * exitCode 0 means a child process ran and exited zero — nothing else produces
 * success. A refusal reports 126 with `refused` set; a timeout reports 124 with
 * `timedOut`. The previous shape could not distinguish "ran and passed" from
 * "never ran", which is how a fabricated `stdout: "Executed: <command>"` came to
 * be trusted as a passing test run.
 */
export interface TerminalResult {
  command: string;
  /** What was actually handed to execFile. Empty when refused. */
  argv: string[];
  /** Resolved binary basename, or null when refused. */
  binary: string | null;
  /** Resolved working directory, or null when refused. */
  cwd: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  /** True when the child was killed (timeout or output cap). */
  killed: boolean;
  /** Terminating signal, when there was one. */
  signal?: string;
  /** True when output hit maxBuffer and is therefore incomplete. */
  truncated: boolean;
  /** Governance verdict, or null when refused before governance was consulted. */
  governanceDecision: string | null;
  matchedRuleId: string | null;
  /** Present only when the command never ran. */
  refused?: TerminalRefusal;
}

export interface DiffResult {
  file: string;
  added: string[];
  removed: string[];
  unchanged: number;
  totalChanges: number;
}

export interface HashResult {
  file: string;
  algorithm: string;
  hash: string;
}
