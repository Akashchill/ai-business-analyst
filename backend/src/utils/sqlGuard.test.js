import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSql, stripSqlComments, extractSqlFromText, rewriteImpossibleOrderSelfJoin, isImpossibleOrderPkSelfJoin } from './sqlGuard.js';

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

describe('rewriteImpossibleOrderSelfJoin', () => {
  const schema = {
    orders: {
      columns: [
        { name: 'id' },
        { name: 'user_id' },
        { name: 'product_id' },
      ],
    },
  };

  const badSql = `SELECT p1.name AS product1, p2.name AS product2, COUNT(DISTINCT o1.id) AS purchase_count
FROM orders AS o1
JOIN orders AS o2 ON o1.id = o2.id AND o1.product_id < o2.product_id
JOIN products AS p1 ON o1.product_id = p1.id
JOIN products AS p2 ON o2.product_id = p2.id
WHERE o1.status = 'completed' AND o2.status = 'completed'
GROUP BY p1.name, p2.name
ORDER BY purchase_count DESC
LIMIT 500`;

  it('rewrites orders PK self-join to user_id', () => {
    const rewritten = rewriteImpossibleOrderSelfJoin(badSql, schema);
    assert.match(rewritten, /o1\.user_id\s*=\s*o2\.user_id/i);
    assert.doesNotMatch(rewritten, /o1\.id\s*=\s*o2\.id/i);
  });

  it('leaves a correct user_id self-join unchanged', () => {
    const good = badSql.replace('o1.id = o2.id', 'o1.user_id = o2.user_id');
    assert.equal(rewriteImpossibleOrderSelfJoin(good, schema), good);
  });

  it('does not rewrite users.id = orders.user_id', () => {
    const sql = 'SELECT u.name FROM users u JOIN orders o ON u.id = o.user_id LIMIT 10';
    assert.equal(rewriteImpossibleOrderSelfJoin(sql, schema), sql);
  });

  it('skips rewrite when orders has no user_id', () => {
    const noUser = { orders: { columns: [{ name: 'id' }, { name: 'product_id' }] } };
    assert.equal(rewriteImpossibleOrderSelfJoin(badSql, noUser), badSql);
  });
});

describe('isImpossibleOrderPkSelfJoin', () => {
  it('detects PK self-join with product pair predicate', () => {
    const sql = 'SELECT 1 FROM orders o1 JOIN orders o2 ON o1.id = o2.id AND o1.product_id < o2.product_id';
    assert.equal(isImpossibleOrderPkSelfJoin(sql), true);
  });

  it('is false without a product_id comparison', () => {
    const sql = 'SELECT 1 FROM orders o1 JOIN orders o2 ON o1.id = o2.id';
    assert.equal(isImpossibleOrderPkSelfJoin(sql), false);
  });
});
