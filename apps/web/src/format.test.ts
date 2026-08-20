import { describe, expect, it } from 'vitest';
import { numericFieldProblem } from './format.js';

describe('numericFieldProblem', () => {
  it('accepts a well-formed, in-range number', () => {
    expect(numericFieldProblem('84', { label: 'Forecast months', required: true })).toBeUndefined();
    expect(numericFieldProblem('0.08', { label: 'Discount rate' })).toBeUndefined();
  });

  it('reports a blank required field, and leaves a blank optional one alone', () => {
    expect(numericFieldProblem('', { label: 'Forecast months', required: true })).toBe(
      'Forecast months is required.',
    );
    expect(numericFieldProblem('   ', { label: 'Forecast months', required: true })).toBe(
      'Forecast months is required.',
    );
    expect(numericFieldProblem('', { label: 'Acquisition price' })).toBeUndefined();
  });

  it('rejects text that is not a number at all, required or not', () => {
    expect(numericFieldProblem('twelve', { label: 'Units' })).toBe('Units must be a number.');
    expect(numericFieldProblem('12,000', { label: 'Units' })).toBe('Units must be a number.');
    expect(numericFieldProblem('12abc', { label: 'Units', required: true })).toBe(
      'Units must be a number.',
    );
  });

  it('enforces min/max only once the value already parses as a number', () => {
    expect(numericFieldProblem('-5', { label: 'Units', min: 0 })).toBe('Units must be at least 0.');
    expect(numericFieldProblem('5', { label: 'Units', min: 0, max: 4 })).toBe(
      'Units must be at most 4.',
    );
    expect(numericFieldProblem('not-a-number', { label: 'Units', min: 0 })).toBe(
      'Units must be a number.',
    );
  });
});
