const MAX_INSIGHT_TEXT = 2000;

/**
 * Lightweight post-checks on LLM insight output (no external moderation API).
 */
export function sanitizeInsight(insight) {
  if (!insight || typeof insight !== 'object') {
    return {
      summary: 'Unable to generate insights at this time.',
      keyFindings: [],
      recommendations: [],
      severity: 'neutral',
    };
  }

  const out = { ...insight };

  if (typeof out.summary === 'string') {
    out.summary = fixJsonLeak(out.summary);
    out.summary = trimText(out.summary, MAX_INSIGHT_TEXT);
  }

  if (Array.isArray(out.keyFindings)) {
    out.keyFindings = out.keyFindings.map(f => trimText(fixJsonLeak(String(f)), 500)).slice(0, 10);
  }

  if (Array.isArray(out.recommendations)) {
    out.recommendations = out.recommendations.map(r => trimText(fixJsonLeak(String(r)), 500)).slice(0, 10);
  }

  if (typeof out.trends === 'string') {
    out.trends = trimText(fixJsonLeak(out.trends), MAX_INSIGHT_TEXT);
  }

  return out;
}

function fixJsonLeak(text) {
  const trimmed = text.trim();
  const leakMatch = trimmed.match(/^\{\s*"summary"\s*:\s*"([\s\S]*)"\s*[,}]/);
  if (leakMatch) {
    try {
      const parsed = JSON.parse(trimmed.startsWith('{') ? trimmed : `{${trimmed}}`);
      if (parsed.summary) return String(parsed.summary);
    } catch {
      return leakMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
  }
  return text;
}

function trimText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
