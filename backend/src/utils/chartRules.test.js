import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickChartByRules, inferColumnRole } from './chartRules.js';

describe('inferColumnRole', () => {
  it('detects numeric columns', () => {
    assert.equal(inferColumnRole('sum', [{ sum: '383.00' }, { sum: 100 }]), 'numeric');
  });

  it('detects date columns', () => {
    assert.equal(inferColumnRole('month', [{ month: '2024-01-01' }, { month: '2024-02-01' }]), 'date');
  });
});

describe('pickChartByRules', () => {
  it('uses number chart for scalar aggregate', () => {
    const r = pickChartByRules('Revenue', [{ sum: '383.00' }]);
    assert.equal(r.chartType, 'number');
    assert.equal(r.ambiguous, false);
  });

  it('uses line for date + numeric series', () => {
    const rows = [
      { month: '2024-01-01', revenue: 100 },
      { month: '2024-02-01', revenue: 120 },
    ];
    const r = pickChartByRules('Monthly revenue', rows, 'trend');
    assert.equal(r.chartType, 'line');
    assert.equal(r.ambiguous, false);
  });

  it('uses bar for category + numeric ranking', () => {
    const rows = [
      { customer: 'Alice', spend: 100 },
      { customer: 'Bob', spend: 80 },
    ];
    const r = pickChartByRules('Top customers', rows, 'ranking');
    assert.equal(r.chartType, 'bar');
    assert.equal(r.ambiguous, false);
  });

  it('marks multi-metric as ambiguous', () => {
    const rows = [
      { revenue: 100, profit: 20, cost: 80 },
      { revenue: 120, profit: 30, cost: 90 },
    ];
    const r = pickChartByRules('Metrics', rows);
    assert.equal(r.ambiguous, true);
  });
});
