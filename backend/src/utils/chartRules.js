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

  if (numericKeys.length > 1 && (categoryKeys.length >= 1 || dateKeys.length >= 1)) {
    return { chartType: 'table', chartConfig: null, ambiguous: true };
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
