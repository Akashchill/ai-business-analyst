function humanizeColumn(name) {
  return String(name)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(value) {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * Build insight text directly from query rows — no LLM call required.
 * Used when the API is unavailable or to avoid burning quota on simple results.
 */
export function buildInsightFromData({ question, sqlResult, ragResult }) {
  const findings = [];
  let summaryParts = [];

  if (sqlResult?.rows?.length) {
    const rows = sqlResult.rows;
    const keys = Object.keys(rows[0]);
    const rowCount = rows.length;

    if (rowCount === 1 && keys.length === 1) {
      const key = keys[0];
      const val = formatValue(rows[0][key]);
      const label = humanizeColumn(key);
      summaryParts.push(`The ${label.toLowerCase()} is ${val}.`);
      findings.push(`${label}: ${val}`);
    } else if (rowCount === 1) {
      const metrics = keys.map((k) => {
        const label = humanizeColumn(k);
        const val = formatValue(rows[0][k]);
        findings.push(`${label}: ${val}`);
        return `${label.toLowerCase()} is ${val}`;
      });
      summaryParts.push(`The query returned: ${metrics.join('; ')}.`);
    } else if (rowCount <= 10) {
      summaryParts.push(`The query returned ${rowCount} rows.`);
      rows.slice(0, 5).forEach((row, i) => {
        const desc = keys.map((k) => `${humanizeColumn(k)}: ${formatValue(row[k])}`).join(', ');
        findings.push(`Row ${i + 1}: ${desc}`);
      });
      if (keys.length === 2 && rowCount > 1) {
        const [xKey, yKey] = keys;
        const top = [...rows].sort((a, b) => Number(b[yKey]) - Number(a[yKey]))[0];
        if (top && !Number.isNaN(Number(top[yKey]))) {
          summaryParts.push(`Top result: ${formatValue(top[xKey])} with ${humanizeColumn(yKey).toLowerCase()} of ${formatValue(top[yKey])}.`);
        }
      }
    } else {
      summaryParts.push(`The query returned ${rowCount.toLocaleString()} rows across ${keys.length} columns (${keys.map(humanizeColumn).join(', ')}).`);
      findings.push(`${rowCount.toLocaleString()} total rows`);
      findings.push(`Columns: ${keys.map(humanizeColumn).join(', ')}`);
    }
  }

  if (ragResult?.answer && !ragResult.noContext) {
    summaryParts.push(ragResult.answer);
    if (ragResult.sources?.length) {
      findings.push(`Document sources: ${ragResult.sources.join(', ')}`);
    }
  }

  if (!summaryParts.length) return null;

  const q = question.trim().endsWith('?') ? question.trim() : `${question.trim()}?`;
  const summary = summaryParts.length === 1 && sqlResult?.rows?.length
    ? `For "${q}" ${summaryParts[0]}`
    : summaryParts.join(' ');

  return {
    summary,
    keyFindings: findings.slice(0, 8),
    recommendations: [],
    severity: 'neutral',
  };
}

export function isAiQuotaError(err) {
  const msg = String(err?.message || err || '');
  return /quota|rate.?limit|429|resource exhausted|too many requests/i.test(msg);
}

/** Rows at or below this use local insight only; above triggers LLM with local fallback. */
export const INSIGHT_LLM_ROW_THRESHOLD = 5;

export function shouldUseLlmInsight(sqlResult) {
  return (sqlResult?.rows?.length ?? 0) > INSIGHT_LLM_ROW_THRESHOLD;
}
