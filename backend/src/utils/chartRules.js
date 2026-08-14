function isDateLike(value) {
  if (value instanceof Date) return true;
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(s);
}

function isNumericLike(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'boolean') return false;
  return !Number.isNaN(Number(value));
}

/**
 * Infer column role from sample values (not DB types — uses result row shapes).
 */
export function inferColumnRole(key, rows) {
  const sample = rows.slice(0, 50).map((r) => r[key]).filter((v) => v != null && v !== '');
  if (!sample.length) return 'empty';

  if (sample.every(isNumericLike)) return 'numeric';
  if (sample.every(isDateLike)) return 'date';
  return 'category';
}

function cardinality(rows, key) {
  return new Set(rows.map((r) => String(r[key]))).size;
}

const YKEY_PREFERENCE = [
  /revenue/, /sales/, /amount/, /spend/, /value/, /total(?!_?(qty|quantity|count))/,
];
const GENERIC_KEY_TOKENS = new Set(['total', 'sum', 'the', 'and', 'for', 'avg', 'average', 'count']);

function mentionScore(key, question) {
  const tokens = key.toLowerCase().replace(/_/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !GENERIC_KEY_TOKENS.has(t));
  if (!tokens.length) return 0;
  return tokens.filter((t) => question.includes(t)).length;
}

/**
 * Pick one numeric column as the chart measure when several exist.
 * Prefers a column named in the question, then revenue-like metrics.
 */
export function pickPreferredYKey(numericKeys, question = '') {
  if (!numericKeys.length) return null;
  const q = question.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const k of numericKeys) {
    const score = mentionScore(k, q);
    if (score > bestScore) {
      best = k;
      bestScore = score;
    }
  }
  if (best) return best;
  for (const re of YKEY_PREFERENCE) {
    const match = numericKeys.find((k) => re.test(k.toLowerCase()));
    if (match) return match;
  }
  return numericKeys[0];
}

/**
 * Rules-first chart selection. Returns ambiguous: true when LLM should decide.
 */
export function pickChartByRules(question, rows, questionType = 'metric') {
  if (!rows?.length) {
    return { chartType: 'table', chartConfig: null, ambiguous: false };
  }

  const keys = Object.keys(rows[0]);
  const roles = Object.fromEntries(keys.map((k) => [k, inferColumnRole(k, rows)]));
  const numericKeys = keys.filter((k) => roles[k] === 'numeric');
  const dateKeys = keys.filter((k) => roles[k] === 'date');
  const categoryKeys = keys.filter((k) => roles[k] === 'category');

  if (rows.length === 1 && keys.length === 1 && numericKeys.length === 1) {
    const key = keys[0];
    return {
      chartType: 'number',
      chartConfig: { xKey: key, yKey: key, title: question },
      ambiguous: false,
    };
  }

  if (rows.length === 1) {
    return { chartType: 'table', chartConfig: null, ambiguous: false };
  }

  if (dateKeys.length >= 1 && numericKeys.length >= 1) {
    return {
      chartType: 'line',
      chartConfig: { xKey: dateKeys[0], yKey: numericKeys[0], title: question },
      ambiguous: false,
    };
  }

  if (categoryKeys.length >= 1 && numericKeys.length === 1) {
    const xKey = categoryKeys[0];
    const yKey = numericKeys[0];
    const cats = cardinality(rows, xKey);

    if (questionType === 'trend' && cats > 8) {
      return { chartType: 'line', chartConfig: { xKey, yKey, title: question }, ambiguous: false };
    }
    if (questionType === 'breakdown' && cats <= 6 && rows.length <= 12) {
      return { chartType: 'pie', chartConfig: { xKey, yKey, title: question }, ambiguous: false };
    }
    if (questionType === 'ranking' || questionType === 'comparison' || cats <= 20) {
      return { chartType: 'bar', chartConfig: { xKey, yKey, title: question }, ambiguous: false };
    }
    if (cats > 50) {
      return { chartType: 'table', chartConfig: null, ambiguous: false };
    }
    return { chartType: 'bar', chartConfig: { xKey, yKey, title: question }, ambiguous: false };
  }

  if (numericKeys.length >= 2 && categoryKeys.length === 0 && dateKeys.length === 0) {
    return { chartType: 'table', chartConfig: null, ambiguous: true };
  }

  // Category/date + multiple metrics: still chartable. Pick one measure so the
  // UI can render a bar/line instead of falling back to table-only.
  if (numericKeys.length > 1 && (categoryKeys.length >= 1 || dateKeys.length >= 1)) {
    const xKey = dateKeys[0] || categoryKeys[0];
    const yKey = pickPreferredYKey(numericKeys, question);
    const cats = categoryKeys.length ? cardinality(rows, categoryKeys[0]) : rows.length;

    if (!dateKeys.length && cats > 50) {
      return { chartType: 'table', chartConfig: null, ambiguous: false };
    }

    let chartType = dateKeys.length >= 1 ? 'line' : 'bar';
    if (!dateKeys.length && questionType === 'breakdown' && cats <= 6 && rows.length <= 12) {
      chartType = 'pie';
    }

    return {
      chartType,
      chartConfig: { xKey, yKey, title: question },
      ambiguous: true,
    };
  }

  if (numericKeys.length === 0) {
    return { chartType: 'table', chartConfig: null, ambiguous: false };
  }

  if (numericKeys.length === 1 && keys.length === 2) {
    const xKey = keys.find((k) => k !== numericKeys[0]);
    return {
      chartType: rows.length > 12 ? 'line' : 'bar',
      chartConfig: { xKey, yKey: numericKeys[0], title: question },
      ambiguous: false,
    };
  }

  return { chartType: 'table', chartConfig: null, ambiguous: true };
}

/** @deprecated use pickChartByRules */
export function heuristicChartConfig(question, rows) {
  const result = pickChartByRules(question, rows);
  return { chartType: result.chartType, chartConfig: result.chartConfig };
}
