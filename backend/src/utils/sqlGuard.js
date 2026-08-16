/**
 * SQL guard — code-level validation before executeQuery().
 *
 * Policy:
 * - Single SELECT only (comments stripped before checks)
 * - Blocked DDL/DML keywords (word boundaries, case-insensitive)
 * - UNION is allowed (still read-only SELECT); multi-statement via ";" is rejected
 * - Non-aggregate row-returning queries without LIMIT get LIMIT appended (default 500)
 * - Optional table allowlist when introspected schema is passed
 */

const DEFAULT_MAX_ROWS = 500;

const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE',
  'GRANT', 'REVOKE', 'COPY', 'EXEC', 'EXECUTE', 'CALL', 'MERGE', 'REPLACE',
  'RENAME', 'ATTACH', 'DETACH', 'VACUUM', 'ANALYZE', 'COMMENT', 'LOCK',
  'SET', 'RESET', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'PREPARE', 'DEALLOCATE',
  'pg_sleep', 'pg_read_file', 'pg_write_file', 'lo_import', 'lo_export',
  'dblink', 'LOAD', 'HANDLER', 'DO', 'INTO OUTFILE', 'INTO DUMPFILE',
  'LOAD_FILE', 'OUTFILE', 'DUMPFILE',
];

const AGGREGATE_FUNCS = ['COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'BOOL_AND', 'BOOL_OR', 'STRING_AGG', 'ARRAY_AGG'];

/**
 * Strip markdown fences / leading labels the LLM sometimes wraps around SQL.
 */
export function unwrapSql(sql) {
  if (sql == null || typeof sql !== 'string') return sql;
  let s = sql.trim();
  s = s.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/i, '').trim();
  s = s.replace(/^sql\s*:\s*/i, '').trim();
  return s;
}

/** Pull a SELECT statement out of free-form model text. */
export function extractSqlFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const unwrapped = unwrapSql(text);

  const jsonSql = unwrapped.match(/"sql"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (jsonSql?.[1]) {
    const fromJson = jsonSql[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, ' ');
    if (/\bSELECT\b/i.test(fromJson)) {
      return fromJson.replace(/;+\s*$/, '').trim();
    }
  }

  const match = unwrapped.match(/\bSELECT\b[\s\S]+/i);
  if (!match) return null;
  return match[0].replace(/;+\s*$/, '').trim();
}

/**
 * Remove SQL comments so hidden keywords cannot bypass the blocklist.
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/**
 * Mask string literals so semicolons inside quotes are ignored.
 */
function maskStringLiterals(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      out += "'";
      i++;
      while (i < sql.length) {
        out += sql[i] === "'" ? ' ' : sql[i];
        if (sql[i] === "'" && sql[i + 1] !== "'") {
          i++;
          break;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += ' ';
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function hasMultipleStatements(sql) {
  const masked = maskStringLiterals(sql).trim();
  const withoutTrailing = masked.replace(/;\s*$/, '');
  return withoutTrailing.includes(';');
}

function containsBlockedKeywords(normalized) {
  const upper = normalized.toUpperCase();
  for (const kw of BLOCKED_KEYWORDS) {
    const pattern = new RegExp(`\\b${kw.replace(/ /g, '\\s+')}\\b`, 'i');
    if (pattern.test(upper)) {
      return kw;
    }
  }
  return null;
}

/**
 * Scalar aggregate: SELECT agg(...) [FROM ...] with no GROUP BY — returns few rows.
 */
function isScalarAggregate(sql) {
  const upper = sql.toUpperCase();
  if (/\bGROUP\s+BY\b/.test(upper)) return false;

  const selectMatch = upper.match(/\bSELECT\s+(DISTINCT\s+)?([\s\S]+?)\s+FROM\b/i);
  if (!selectMatch) {
    const selectOnly = upper.match(/\bSELECT\s+(DISTINCT\s+)?([\s\S]+?)\s*$/i);
    if (!selectOnly) return false;
    const cols = selectOnly[2];
    return AGGREGATE_FUNCS.some(fn => new RegExp(`\\b${fn}\\s*\\(`, 'i').test(cols));
  }

  const cols = selectMatch[2];
  const parts = cols.split(',').map(p => p.trim());
  return parts.every(part => AGGREGATE_FUNCS.some(fn => new RegExp(`^${fn}\\s*\\(`, 'i').test(part) || new RegExp(`\\b${fn}\\s*\\(`, 'i').test(part)));
}

function extractLimitValue(sql) {
  const match = sql.match(/\bLIMIT\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function enforceLimit(sql, maxRows) {
  const existing = extractLimitValue(sql);
  if (existing !== null) {
    if (existing > maxRows) {
      return { ok: false, error: `LIMIT ${existing} exceeds maximum allowed (${maxRows})` };
    }
    return { ok: true, sql };
  }

  if (isScalarAggregate(sql)) {
    return { ok: true, sql };
  }

  return { ok: true, sql: `${sql.replace(/;\s*$/, '').trim()} LIMIT ${maxRows}` };
}

/**
 * Extract referenced table names from FROM / JOIN clauses.
 */
function extractTableNames(sql) {
  const tables = new Set();
  const pattern = /\b(?:FROM|JOIN)\s+([`"[\]]?)(\w+)\1/gi;
  let m;
  while ((m = pattern.exec(sql)) !== null) {
    tables.add(m[2].toLowerCase());
  }
  return [...tables];
}

function validateTableAllowlist(sql, schema) {
  if (!schema || typeof schema !== 'object') return null;

  const allowed = new Set(Object.keys(schema).map(t => t.toLowerCase()));
  const referenced = extractTableNames(sql);
  const unknown = referenced.filter(t => !allowed.has(t));
  if (unknown.length) {
    return `Query references tables not in schema: ${unknown.join(', ')}`;
  }
  return null;
}

/**
 * @param {string|null|undefined} sql
 * @param {{ maxRows?: number, schema?: Record<string, unknown>|null }} [options]
 * @returns {{ ok: true, sql: string } | { ok: false, error: string }}
 */
export function validateSql(sql, options = {}) {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  sql = unwrapSql(sql);

  if (sql == null || typeof sql !== 'string' || !sql.trim()) {
    return { ok: false, error: 'SQL query is empty' };
  }

  const trimmed = sql.trim();

  if (hasMultipleStatements(trimmed)) {
    return { ok: false, error: 'Multiple SQL statements are not allowed' };
  }

  const withoutComments = stripSqlComments(trimmed).trim();
  if (!withoutComments) {
    return { ok: false, error: 'SQL query is empty after removing comments' };
  }

  if (!/^\s*SELECT\b/i.test(withoutComments)) {
    return { ok: false, error: 'Only SELECT queries are allowed' };
  }

  const blocked = containsBlockedKeywords(withoutComments);
  if (blocked) {
    return { ok: false, error: `Blocked SQL keyword: ${blocked}` };
  }

  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(withoutComments)) {
    return { ok: false, error: 'INTO OUTFILE / DUMPFILE is not allowed' };
  }

  const tableError = validateTableAllowlist(withoutComments, options.schema);
  if (tableError) {
    return { ok: false, error: tableError };
  }

  return enforceLimit(withoutComments, maxRows);
}
