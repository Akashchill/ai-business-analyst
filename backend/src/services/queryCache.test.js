import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQuestion,
  cacheKey,
  isCacheableResult,
  shouldStorePayload,
  MAX_CACHEABLE_ROWS,
  MAX_CACHEABLE_BYTES,
} from './queryCache.js';

describe('normalizeQuestion', () => {
  it('trims, lowercases, collapses whitespace, and strips trailing question marks', () => {
    assert.equal(normalizeQuestion('  How   Many Users?? '), 'how many users');
  });

  it('treats empty or missing input as empty string', () => {
    assert.equal(normalizeQuestion(''), '');
    assert.equal(normalizeQuestion(null), '');
    assert.equal(normalizeQuestion(undefined), '');
  });
});

describe('cacheKey', () => {
  it('is stable for equivalent questions', () => {
    assert.equal(
      cacheKey('How many users?', 'postgresql'),
      cacheKey('how many users', 'postgresql'),
    );
    assert.equal(
      cacheKey('  HOW MANY   USERS??', 'postgresql'),
      cacheKey('how many users', 'postgresql'),
    );
  });

  it('differs by dbType', () => {
    assert.notEqual(
      cacheKey('how many users', 'postgresql'),
      cacheKey('how many users', 'mysql'),
    );
  });

  it('uses the query prefix', () => {
    assert.match(cacheKey('how many users', 'postgresql'), /^query:postgresql:[a-f0-9]{64}$/);
  });
});

describe('isCacheableResult', () => {
  const analyticsOk = {
    success: true,
    responseMode: 'analytics',
    intent: 'analytics_sql',
    rowCount: 3,
  };

  it('accepts successful analytics results', () => {
    assert.equal(isCacheableResult(analyticsOk), true);
  });

  it('skips greeting, general_business, and out_of_scope', () => {
    assert.equal(isCacheableResult({ success: true, responseMode: 'direct', intent: 'greeting' }), false);
    assert.equal(isCacheableResult({ success: true, responseMode: 'direct', intent: 'general_business' }), false);
    assert.equal(isCacheableResult({ success: true, responseMode: 'declined', intent: 'out_of_scope' }), false);
  });

  it('skips failed pipeline runs', () => {
    assert.equal(isCacheableResult({ success: false, responseMode: 'analytics', rowCount: 1 }), false);
    assert.equal(isCacheableResult(null), false);
  });

  it('skips oversized row counts', () => {
    assert.equal(isCacheableResult({ ...analyticsOk, rowCount: MAX_CACHEABLE_ROWS }), true);
    assert.equal(isCacheableResult({ ...analyticsOk, rowCount: MAX_CACHEABLE_ROWS + 1 }), false);
  });
});

describe('shouldStorePayload', () => {
  it('rejects payloads over 512KB', () => {
    assert.equal(shouldStorePayload('ok'), true);
    assert.equal(shouldStorePayload('x'.repeat(MAX_CACHEABLE_BYTES)), true);
    assert.equal(shouldStorePayload('x'.repeat(MAX_CACHEABLE_BYTES + 1)), false);
  });
});
