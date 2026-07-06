import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsightFromData, shouldUseLlmInsight } from './insightBuilder.js';
import { pickChartByRules } from './chartRules.js';

describe('buildInsightFromData', () => {
  it('summarizes a single aggregate row', () => {
    const insight = buildInsightFromData({
      question: 'What is total revenue this month?',
      sqlResult: { rows: [{ sum: '383.00' }] },
    });
    assert.ok(insight);
    assert.match(insight.summary, /383\.00/);
    assert.ok(insight.keyFindings.some((f) => f.includes('383.00')));
  });

  it('summarizes multi-row results', () => {
    const insight = buildInsightFromData({
      question: 'Top customers',
      sqlResult: {
        rows: [
          { name: 'Alice', spend: 100 },
          { name: 'Bob', spend: 50 },
        ],
      },
    });
    assert.ok(insight);
    assert.match(insight.summary, /2 rows/);
  });
});

describe('pickChartByRules (via chartRules)', () => {
  it('uses number chart for scalar aggregate', () => {
    const viz = pickChartByRules('Revenue', [{ sum: '383.00' }]);
    assert.equal(viz.chartType, 'number');
  });
});

describe('shouldUseLlmInsight', () => {
  it('is false for 5 or fewer rows', () => {
    assert.equal(shouldUseLlmInsight({ rows: [{ a: 1 }] }), false);
    assert.equal(shouldUseLlmInsight({ rows: Array(5).fill({ a: 1 }) }), false);
  });

  it('is true for more than 5 rows', () => {
    assert.equal(shouldUseLlmInsight({ rows: Array(6).fill({ a: 1 }) }), true);
  });
});
