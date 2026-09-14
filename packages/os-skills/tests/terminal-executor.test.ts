import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalExecutor, tokenize, isTransientSpawnError } from '../src/terminal-executor.js';
import { GovernanceGateway, PolicyEngine, PolicyDecision } from '@agi-os/governance';

/**
 * These tests spawn real child processes. Every assertion is about observable
 * behaviour of a program that actually ran, or about a refusal that provably
 * prevented one from running.
 */
describe('TerminalExecutor', () => {
  let jail: string;
  let exec: TerminalExecutor;

  beforeEach(() => {
    jail = mkdtempSync(join(tmpdir(), 'agi-terminal-'));
    exec = new TerminalExecutor({
      rootDir: jail,
      timeoutMs: 5000,
      allowed: ['echo', 'node', 'pwd', 'cat', 'env', 'ls', 'sleep', 'definitely-not-installed-xyz'],
    });
  });

  afterEach(() => {
    rmSync(jail, { recursive: true, force: true });
  });

  describe('real execution', () => {
    it('returns the program\'s actual stdout', async () => {
      const result = await exec.execute('echo hello');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\n');
      expect(result.refused).toBeUndefined();
    });

    it('never fabricates output that merely echoes the command back', async () => {
      const result = await exec.execute('echo hello');
      // The previous implementation returned `Executed: <command>` with exit 0
      // for any allowlisted command, so a failing test suite looked like a
      // passing one. This is the regression guard for that lie.
      expect(result.stdout).not.toContain('Executed:');
      expect(result.stdout).not.toContain('echo hello');
    });

    it('reports the argv, binary and cwd that were really used', async () => {
      const result = await exec.execute('echo one two');
      expect(result.argv).toEqual(['echo', 'one', 'two']);
      expect(result.binary).toBe('echo');
      expect(result.cwd).toBe(jail);
      expect(result.governanceDecision).toBe(PolicyDecision.ALLOW);
      expect(result.matchedRuleId).toBe('POL-010');
    });

    it('propagates a real non-zero exit code', async () => {
      const result = await exec.execute('node -e "process.exit(3)"');
      expect(result.exitCode).toBe(3);
      expect(result.timedOut).toBe(false);
      expect(result.refused).toBeUndefined();
    });

    it('captures the program\'s stderr separately from stdout', async () => {
      const result = await exec.execute('node -e "console.log(\'out\');console.error(\'boom\');process.exit(1)"');
      expect(result.stdout).toBe('out\n');
      expect(result.stderr).toContain('boom');
      expect(result.exitCode).toBe(1);
    });

    it('runs inside the jail and reports the resolved directory', async () => {
      const result = await exec.execute('pwd');
      expect(result.stdout.trim()).toBe(jail);
    });

    it('accepts a cwd inside the jail', async () => {
      mkdirSync(join(jail, 'nested'));
      const result = await exec.execute('pwd', { cwd: 'nested' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(join(jail, 'nested'));
    });

    it('passes stdin to the child', async () => {
      const result = await exec.execute('cat', { stdin: 'from-stdin' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('from-stdin');
    });

    it('reports a missing binary as 127, not as a successful empty run', async () => {
      const result = await exec.execute('definitely-not-installed-xyz');
      expect(result.exitCode).toBe(127);
      expect(result.refused).toBeUndefined(); // it was allowed; the spawn failed
      expect(result.stdout).toBe('');
    });

    it('executeFile runs a binary with explicit arguments', async () => {
      const result = await exec.executeFile('echo', ['a b', "c'd"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b c'd\n");
      expect(result.argv).toEqual(['echo', 'a b', "c'd"]);
    });
  });

  describe('environment isolation', () => {
    it('gives the child only the allowlisted environment', async () => {
      const result = await exec.execute('node -e "console.log(Object.keys(process.env).sort().join(\',\'))"');
      expect(result.exitCode).toBe(0);
      const keys = result.stdout.trim().split(',');
      expect(keys).not.toContain('OPENAI_API_KEY');
      expect(keys).not.toContain('AWS_SECRET_ACCESS_KEY');
      // PATH must survive or nothing can be resolved.
      expect(keys).toContain('PATH');
    });

    it('does not leak a secret that exists in the host environment', async () => {
      process.env.AGI_TEST_SECRET = 's3cr3t-value';
      try {
        const result = await exec.execute('node -e "console.log(String(process.env.AGI_TEST_SECRET))"');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('undefined');
      } finally {
        delete process.env.AGI_TEST_SECRET;
      }
    });

    it('merges caller-supplied variables without replacing the base', async () => {
      const result = await exec.execute('node -e "console.log(process.env.MY_VAR, !!process.env.PATH)"', {
        env: { MY_VAR: 'present' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('present true');
    });
  });

  describe('refusals never spawn a child', () => {
    const expectNoExecution = (result: Awaited<ReturnType<TerminalExecutor['execute']>>) => {
      expect(result.exitCode).toBe(126);
      expect(result.argv).toEqual([]);
      expect(result.binary).toBeNull();
      expect(result.cwd).toBeNull();
      expect(result.refused).toBeDefined();
    };

    it('refuses a destructive command', async () => {
      const result = await exec.execute('rm -rf /');
      expectNoExecution(result);
      expect(result.refused?.code).toBe('DANGEROUS_COMMAND');
    });

    it('refuses a binary that is not on the allowlist', async () => {
      const result = await exec.execute('curl http://example.com');
      expectNoExecution(result);
      // curl is screened as dangerous before the allowlist is consulted; either
      // refusal is acceptable as long as nothing ran.
      expect(['DANGEROUS_COMMAND', 'NOT_ALLOWED']).toContain(result.refused?.code);
    });

    it('refuses an unknown binary', async () => {
      const result = await exec.execute('hack-the-planet');
      expectNoExecution(result);
      expect(result.refused?.code).toBe('NOT_ALLOWED');
    });

    it.each([';', '|', '&', '>', '<', '$(', '`'])('refuses the shell operator %s', async (op) => {
      const result = await exec.execute(`echo a ${op} echo b`);
      expectNoExecution(result);
      expect(result.refused?.code).toBe('SHELL_OPERATOR');
    });

    it('passes a quoted operator through as a literal argument', async () => {
      // No shell is involved, so a quoted `;` is just data. Refusing it would
      // break ordinary arguments such as `node -e "a();b()"`.
      const result = await exec.execute(`node -e "console.log('a;b')"`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('a;b\n');
      expect(result.refused).toBeUndefined();
    });

    it('refuses the same operator when it is unquoted', async () => {
      const result = await exec.execute('echo a;b');
      expect(result.exitCode).toBe(126);
      expect(result.refused?.code).toBe('SHELL_OPERATOR');
      expect(result.refused?.reason).toContain(';');
    });

    it('refuses an absolute cwd outside the jail', async () => {
      const result = await exec.execute('pwd', { cwd: '/etc' });
      expectNoExecution(result);
      expect(result.refused?.code).toBe('CWD_OUTSIDE_JAIL');
    });

    it('refuses a relative cwd that escapes the jail', async () => {
      const result = await exec.execute('pwd', { cwd: '../../..' });
      expectNoExecution(result);
      expect(result.refused?.code).toBe('CWD_OUTSIDE_JAIL');
    });

    it('refuses an empty command', async () => {
      const result = await exec.execute('   ');
      expectNoExecution(result);
      expect(result.refused?.code).toBe('EMPTY_COMMAND');
    });

    it('refuses unterminated quoting rather than guessing', async () => {
      const result = await exec.execute('echo "unterminated');
      expectNoExecution(result);
      expect(result.refused?.code).toBe('MALFORMED_COMMAND');
    });

    it('refuses an explicit blocklist substring even for an allowed binary', async () => {
      const guarded = new TerminalExecutor({ rootDir: jail, blocked: ['--force'] });
      const result = await guarded.execute('git push --force');
      expect(result.exitCode).toBe(126);
      expect(result.refused?.code).toBe('BLOCKED_SUBSTRING');
    });
  });

  describe('path-qualified binaries cannot bypass the allowlist', () => {
    it('refuses /tmp/evil/ls even though its basename is allowlisted', async () => {
      // A basename comparison would let this through and execFile would then run
      // the attacker's binary. Prove the file exists and is executable, so the
      // test would genuinely fail if the bypass were reintroduced.
      const evilDir = join(jail, 'evil');
      mkdirSync(evilDir);
      const evil = join(evilDir, 'ls');
      writeFileSync(evil, '#!/bin/sh\necho PWNED\n');
      chmodSync(evil, 0o755);

      const result = await exec.execute(evil);
      expect(result.exitCode).toBe(126);
      expect(result.refused?.code).toBe('PATH_QUALIFIED_BINARY');
      expect(result.stdout).not.toContain('PWNED');
    });

    it('refuses a relative path-qualified program', async () => {
      const result = await exec.execute('./ls');
      expect(result.refused?.code).toBe('PATH_QUALIFIED_BINARY');
    });

    it('refuses a path-qualified binary passed to executeFile', async () => {
      const result = await exec.executeFile('/usr/bin/echo', ['hi']);
      expect(result.refused?.code).toBe('PATH_QUALIFIED_BINARY');
    });
  });

  describe('resource limits', () => {
    it('kills a command that exceeds its CPU budget and says so', async () => {
      const result = await exec.execute('node -e "while(true){}"', { timeoutMs: 500 });
      expect(result.exitCode).toBe(124);
      expect(result.timedOut).toBe(true);
      expect(result.killed).toBe(true);
      expect(result.refused).toBeUndefined();
      expect(result.stderr).toContain('timed out');
    });

    it('caps runaway output and reports the truncation', async () => {
      const capped = new TerminalExecutor({ rootDir: jail, maxBufferBytes: 2048, allowed: ['node'] });
      const result = await capped.execute('node -e "console.log(\'x\'.repeat(200000))"');
      expect(result.truncated).toBe(true);
      expect(result.killed).toBe(true);
      expect(result.stdout.length).toBeLessThan(200000);
    });

    it('kills a child that sleeps past the timeout', async () => {
      const result = await exec.execute('sleep 30', { timeoutMs: 400 });
      expect(result.timedOut).toBe(true);
      // The point is that the 30s child was cut short, not that the whole spawn
      // and reap finished inside a tight budget. A 5s bound here made the test
      // depend on how loaded the runner is; half the child's own lifetime still
      // proves early termination and survives contention.
      expect(result.duration).toBeLessThan(15_000);
    });
  });

  describe('governance integration', () => {
    it('surfaces a BLOCK decision without running the command', async () => {
      const policy = new PolicyEngine();
      policy.addRule({
        id: 'TEST-BLOCK',
        description: 'Block any command mentioning the forbidden token',
        condition: (i) => i.module === 'exec' && i.target.includes('forbidden-token'),
        enforce: PolicyDecision.BLOCK,
        priority: 200,
        enabled: true,
        tags: ['test'],
      });
      const guarded = new TerminalExecutor({
        rootDir: jail,
        allowed: ['echo'],
        governance: new GovernanceGateway({ policy, workspaceRoots: [jail] }),
      });

      const result = await guarded.execute('echo forbidden-token');
      expect(result.exitCode).toBe(126);
      expect(result.refused?.code).toBe('GOVERNANCE_BLOCKED');
      expect(result.governanceDecision).toBe(PolicyDecision.BLOCK);
      expect(result.stdout).not.toContain('forbidden-token');
    });

    it('surfaces REQUIRE_APPROVAL with a request id and does not run', async () => {
      // `cat .env` is allowlisted and jailed, but the risk model recognises the
      // secret filename and escalates POL-010's ALLOW to REQUIRE_APPROVAL.
      writeFileSync(join(jail, '.env'), 'SECRET=nope\n');
      const result = await exec.execute('cat .env');
      expect(result.exitCode).toBe(126);
      expect(result.refused?.code).toBe('GOVERNANCE_APPROVAL_REQUIRED');
      expect(result.refused?.approvalRequestId).toBeTruthy();
      expect(result.stdout).not.toContain('SECRET=nope');
    });

    it('allows an innocuous command through POL-010', async () => {
      const result = await exec.execute('echo fine');
      expect(result.exitCode).toBe(0);
      expect(result.governanceDecision).toBe(PolicyDecision.ALLOW);
      expect(result.matchedRuleId).toBe('POL-010');
    });

    it('does not mistake process.env in a command for the .env file', async () => {
      // Regression: substring matching on `.env` used to score this HIGH and
      // escalate an explicit ALLOW to REQUIRE_APPROVAL.
      const result = await exec.execute('node -e "console.log(typeof process.env)"');
      expect(result.exitCode).toBe(0);
      expect(result.refused).toBeUndefined();
      expect(result.stdout.trim()).toBe('object');
    });
  });

  describe('transient spawn failures', () => {
    it('classifies host resource errors as retryable', () => {
      for (const errno of ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY']) {
        expect(isTransientSpawnError(errno), errno).toBe(true);
      }
    });

    it('never retries a permanent spawn failure', () => {
      // A missing binary is a fact about the command, not about host pressure.
      // Retrying it would burn four attempts and still report 127.
      for (const errno of ['ENOENT', 'EACCES', 'EPERM', 'ENOBUFS', null, undefined, '']) {
        expect(isTransientSpawnError(errno), String(errno)).toBe(false);
      }
    });

    it('reports a missing binary immediately rather than after the retry budget', async () => {
      const retrying = new TerminalExecutor({
        rootDir: jail,
        spawnAttempts: 4,
        allowed: ['definitely-not-installed-xyz'],
      });
      const result = await retrying.execute('definitely-not-installed-xyz');
      expect(result.exitCode).toBe(127);
      // The linear backoff would add 120+240+360 = 720ms if ENOENT were retried.
      expect(result.duration).toBeLessThan(500);
    });

    it('clamps the attempt budget to at least one', () => {
      expect(new TerminalExecutor({ rootDir: jail }).getSpawnAttempts()).toBe(4);
      expect(new TerminalExecutor({ rootDir: jail, spawnAttempts: 0 }).getSpawnAttempts()).toBe(1);
      expect(new TerminalExecutor({ rootDir: jail, spawnAttempts: -5 }).getSpawnAttempts()).toBe(1);
      expect(new TerminalExecutor({ rootDir: jail, spawnAttempts: 2 }).getSpawnAttempts()).toBe(2);
    });
  });

  describe('history', () => {
    it('records every attempt, including refusals', async () => {
      await exec.execute('echo one');
      await exec.execute('rm -rf /');
      const history = exec.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].exitCode).toBe(0);
      expect(history[1].refused?.code).toBe('DANGEROUS_COMMAND');
    });

    it('bounds history so a long-lived executor cannot grow forever', async () => {
      const bounded = new TerminalExecutor({ rootDir: jail, historyLimit: 3, allowed: ['echo'] });
      for (const n of [1, 2, 3, 4, 5]) await bounded.execute(`echo ${n}`);
      const history = bounded.getHistory();
      expect(history).toHaveLength(3);
      expect(history.map((h) => h.stdout.trim())).toEqual(['3', '4', '5']);
    });

    it('clears history', async () => {
      await exec.execute('echo one');
      exec.clearHistory();
      expect(exec.getHistory()).toHaveLength(0);
    });
  });

  describe('tokenize', () => {
    it('splits on whitespace', () => {
      expect(tokenize('echo a b')).toEqual(['echo', 'a', 'b']);
    });

    it('keeps single-quoted text literal', () => {
      expect(tokenize(`echo 'a  b'`)).toEqual(['echo', 'a  b']);
    });

    it('keeps double-quoted text literal without expanding variables', () => {
      expect(tokenize('echo "$HOME"')).toEqual(['echo', '$HOME']);
    });

    it('honours backslash escapes outside single quotes', () => {
      expect(tokenize('echo a\\ b')).toEqual(['echo', 'a b']);
    });

    it('throws on unterminated quotes', () => {
      expect(() => tokenize('echo "oops')).toThrow();
    });
  });
});
