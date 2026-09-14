import { describe, it, expect, beforeEach } from 'vitest';
import { LocalVectorEngine, createLocalVectorEngine } from '../src/vector/vector-engine.js';
import { SemanticVectorMemory, createSemanticVectorMemory } from '../src/semantic-vector-memory.js';

// ===========================================================================
// LocalVectorEngine
// ===========================================================================
describe('LocalVectorEngine', () => {
  let engine: LocalVectorEngine;

  beforeEach(() => {
    engine = new LocalVectorEngine({ dimension: 128 });
  });

  // ---- Embedding ---------------------------------------------------------
  describe('generateEmbedding', () => {
    it('should produce a vector of correct dimension', () => {
      const vec = engine.generateEmbedding('hello world');
      expect(vec.length).toBe(128);
    });

    it('should be deterministic — same input produces same output', () => {
      const a = engine.generateEmbedding('test input');
      const b = engine.generateEmbedding('test input');
      expect(a).toEqual(b);
    });

    it('should produce different vectors for different inputs', () => {
      const a = engine.generateEmbedding('database optimization');
      const b = engine.generateEmbedding('network security');
      const same = a.every((v, i) => v === b[i]);
      expect(same).toBe(false);
    });

    it('should produce L2-normalized vectors', () => {
      const vec = engine.generateEmbedding('normalize me');
      const magnitude = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1.0, 5);
    });

    it('should handle empty string', () => {
      const vec = engine.generateEmbedding('');
      expect(vec.length).toBe(128);
      expect(vec.every((v) => v === 0)).toBe(true);
    });
  });

  // ---- Cosine Similarity -------------------------------------------------
  describe('cosineSimilarity', () => {
    it('should return 1.0 for identical vectors', () => {
      const vec = engine.generateEmbedding('same text');
      expect(engine.cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      // Use a 3-dim engine for this test
      const e3 = new LocalVectorEngine({ dimension: 3 });
      expect(e3.cosineSimilarity(a, b)).toBe(0);
    });

    it('should return higher score for similar texts', () => {
      const scoreHigh = engine.cosineSimilarity(
        engine.generateEmbedding('database query optimization'),
        engine.generateEmbedding('optimize database queries')
      );
      const scoreLow = engine.cosineSimilarity(
        engine.generateEmbedding('database query optimization'),
        engine.generateEmbedding('cooking recipe ingredients')
      );
      expect(scoreHigh).toBeGreaterThan(scoreLow);
    });

    it('should handle zero vectors gracefully', () => {
      const zero = new Array(64).fill(0);
      expect(engine.cosineSimilarity(zero, zero)).toBe(0);
    });
  });

  // ---- Insert & Search ---------------------------------------------------
  describe('insert and search', () => {
    it('should insert and retrieve by ID', () => {
      engine.insertWithId('doc-1', 'test content', { tag: 'test' });
      expect(engine.get('doc-1')).toBeDefined();
      expect(engine.get('doc-1')?.text).toBe('test content');
    });

    it('should search and return sorted results', () => {
      engine.insertWithId('db', 'SQLite database optimization techniques');
      engine.insertWithId('net', 'Network firewall configuration');
      engine.insertWithId('sec', 'Security vulnerability assessment');

      const results = engine.search('database performance', 3);
      expect(results.length).toBe(3);
      expect(results[0].document.id).toBe('db');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('should respect topK limit', () => {
      for (let i = 0; i < 10; i++) {
        engine.insertWithId(`doc-${i}`, `document number ${i}`);
      }
      const results = engine.search('document', 3);
      expect(results.length).toBe(3);
    });

    it('should handle delete', () => {
      engine.insertWithId('del-me', 'delete this');
      expect(engine.get('del-me')).toBeDefined();
      engine.delete('del-me');
      expect(engine.get('del-me')).toBeUndefined();
    });

    it('should handle clear', () => {
      engine.insertWithId('a', 'one');
      engine.insertWithId('b', 'two');
      expect(engine.count()).toBe(2);
      engine.clear();
      expect(engine.count()).toBe(0);
    });
  });
});

// ===========================================================================
// SemanticVectorMemory
// ===========================================================================
describe('SemanticVectorMemory', () => {
  let memory: SemanticVectorMemory;

  beforeEach(() => {
    memory = new SemanticVectorMemory(128);
  });

  it('should store and search lessons', async () => {
    memory.store('lesson-1', 'Always use indexed columns in SQLite for WHERE clauses and queries');
    memory.store('lesson-2', 'Never log .env credentials or raw JWT tokens to stdout');
    memory.store('lesson-3', 'Use connection pooling for database performance optimization');

    const results = memory.search('SQLite database queries optimization', 3);
    expect(results.length).toBeGreaterThan(0);
    // lesson-1 and lesson-3 both relate to database — either is acceptable
    expect(['lesson-1', 'lesson-3']).toContain(results[0].document.id);
  });

  it('should find most relevant item', () => {
    memory.store('l1', 'CORS configuration for cross-origin requests');
    memory.store('l2', 'Rate limiting API endpoints');

    const best = memory.findMostRelevant('CORS headers');
    expect(best).not.toBeNull();
    expect(best!.document.id).toBe('l1');
    expect(best!.score).toBeGreaterThan(0.3);
  });

  it('should return null for empty store', () => {
    const best = memory.findMostRelevant('anything');
    expect(best).toBeNull();
  });

  it('should track document count', () => {
    expect(memory.count()).toBe(0);
    memory.store('a', 'first');
    memory.store('b', 'second');
    expect(memory.count()).toBe(2);
  });

  it('should handle metadata', () => {
    memory.store('m1', 'Lesson about rate limiting', { severity: 'high', domain: 'api' });
    const results = memory.search('rate limit');
    expect(results[0].document.metadata.severity).toBe('high');
  });

  it('should execute under 50ms (zero-cost local guarantee)', () => {
    // Measured as the fastest of several runs on a fresh instance. A single
    // sample timed with Date.now() — millisecond granularity — against a 50ms
    // budget turns one GC pause or scheduler preemption into a red suite that
    // says nothing about the code. The minimum of N runs stays stable under the
    // contention of a parallel test run while still catching a real regression,
    // which slows every sample rather than one.
    let elapsed = Number.POSITIVE_INFINITY;

    for (let run = 0; run < 4; run++) {
      const fresh = new SemanticVectorMemory(128);
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        fresh.store(`lesson-${i}`, `Performance test lesson number ${i}`);
      }
      fresh.search('performance test', 10);
      elapsed = Math.min(elapsed, performance.now() - start);
    }

    expect(elapsed).toBeLessThan(50);
  });

  it('should differentiate between semantically different content', () => {
    memory.store('db', 'PostgreSQL database indexing strategies for performance');
    memory.store('ui', 'React component state management patterns');
    memory.store('net', 'TCP/IP networking fundamentals and protocols');

    // Each query should rank its own document highest
    const dbResults = memory.search('database indexing performance');
    const dbRank = dbResults.findIndex((r) => r.document.id === 'db');
    expect(dbRank).toBe(0);

    const uiResults = memory.search('React component state');
    const uiRank = uiResults.findIndex((r) => r.document.id === 'ui');
    expect(uiRank).toBe(0);

    const netResults = memory.search('networking protocols TCP');
    const netRank = netResults.findIndex((r) => r.document.id === 'net');
    expect(netRank).toBe(0);
  });
});

// ===========================================================================
// Factory functions
// ===========================================================================
describe('Factory functions', () => {
  it('createLocalVectorEngine should return working engine', () => {
    const engine = createLocalVectorEngine();
    const vec = engine.generateEmbedding('test');
    expect(vec.length).toBe(128);
  });

  it('createSemanticVectorMemory should return working memory', () => {
    const mem = createSemanticVectorMemory();
    mem.store('test', 'test content');
    expect(mem.count()).toBe(1);
  });
});
