import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSql, stripSqlComments, extractSqlFromText } from './sqlGuard.js';

describe('stripSqlComments', () => {
  it('removes line and block comments', () => {
    const sql = 'SELECT 1 -- hidden\n/* block */ FROM users';
    assert.equal(stripSqlComments(sql).replace(/\s+/g, ' ').trim(), 'SELECT 1 FROM users');
  });
});

describe('validateSql', () => {
  it('accepts valid SELECT COUNT', () => {
    const result = validateSql('SELECT COUNT(*) FROM users');
    assert.equal(result.ok, true);
    assert.match(result.sql, /SELECT COUNT\(\*\) FROM users/i);
    assert.doesNotMatch(result.sql, /LIMIT/i);
  });

  it('unwraps markdown-fenced SQL', () => {
    const result = validateSql('```sql\nSELECT COUNT(*) FROM users\n```');
    assert.equal(result.ok, true);
    assert.match(result.sql, /SELECT COUNT\(\*\) FROM users/i);
  });

  it('rejects empty SQL', () => {
    assert.equal(validateSql('').ok, false);
    assert.equal(validateSql(null).ok, false);
  });

  it('rejects DELETE', () => {
    const result = validateSql('DELETE FROM users');
    assert.equal(result.ok, false);
    assert.match(result.error, /SELECT/i);
  });

  it('rejects multi-statement injection', () => {
    const result = validateSql('SELECT 1; DROP TABLE users');
    assert.equal(result.ok, false);
    assert.match(result.error, /Multiple/i);
  });

  it('rejects INSERT', () => {
    const result = validateSql('INSERT INTO users (name) VALUES (\'x\')');
    assert.equal(result.ok, false);
    assert.match(result.error, /Blocked|SELECT/i);
  });

  it('strips comments before validation (commented keywords are not executed)', () => {
    const result = validateSql('SELECT id /* DELETE */ FROM users');
    assert.equal(result.ok, true);
    assert.match(result.sql, /FROM users/i);
  });

  it('appends LIMIT when missing on row-returning query', () => {
    const result = validateSql('SELECT * FROM orders');
    assert.equal(result.ok, true);
    assert.match(result.sql, /LIMIT 500$/i);
  });

  it('rejects LIMIT above max', () => {
    const result = validateSql('SELECT * FROM orders LIMIT 1000', { maxRows: 500 });
    assert.equal(result.ok, false);
    assert.match(result.error, /exceeds maximum/i);
  });

  it('enforces table allowlist from schema', () => {
    const schema = { users: { columns: [] }, orders: { columns: [] } };
    const bad = validateSql('SELECT * FROM secrets', { schema });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /not in schema/i);

    const good = validateSql('SELECT * FROM users', { schema });
    assert.equal(good.ok, true);
  });

  it('allows UNION SELECT (read-only)', () => {
    const result = validateSql('SELECT id FROM users UNION SELECT id FROM orders LIMIT 10');
    assert.equal(result.ok, true);
  });
});

describe('extractSqlFromText', () => {
  it('pulls SELECT out of prose', () => {
    const sql = extractSqlFromText('Sure.\nSELECT COUNT(*) FROM users;');
    assert.match(sql, /SELECT COUNT\(\*\) FROM users/i);
  });

  it('pulls SELECT out of JSON', () => {
    const sql = extractSqlFromText('{"sql":"SELECT COUNT(*) FROM users","explanation":"count","confidence":0.9}');
    assert.match(sql, /SELECT COUNT\(\*\) FROM users/i);
  });
});
