import type { WorkbookModel } from './model.js';

/**
 * How much of the workbook is genuinely formula-driven.
 *
 * The failure this exists to prevent is believing the export is a live model
 * when whole schedules are pasted numbers. A workbook can look entirely
 * plausible while being inert, and no amount of reading it proves otherwise —
 * so the exporter counts.
 *
 * Only *derived* cells are counted. Labels, headers, tenant names and the
 * assumptions the reader is meant to edit are excluded, because a formula in
 * any of those would be wrong rather than better. The denominator is therefore
 * "cells that ought to be calculated", not "cells".
 */

export interface CoverageReport {
  /** Cells that ought to be calculated: `formula` + `staticDerived`. */
  calculatedCells: number;
  formulaCells: number;
  /** Derived but written as a number. Each one is a gap. */
  staticDerivedCells: number;
  /** `formulaCells / calculatedCells`, or 1 when there is nothing to calculate. */
  formulaCoverage: number;
  inputCells: number;
  labelCells: number;
  /** Per sheet, worst coverage first, so the weakest area is at the top. */
  bySheet: Array<{
    sheet: string;
    calculatedCells: number;
    formulaCells: number;
    staticDerivedCells: number;
    formulaCoverage: number;
  }>;
}

export function measureCoverage(model: WorkbookModel): CoverageReport {
  const bySheet: CoverageReport['bySheet'] = [];
  let formulaCells = 0;
  let staticDerivedCells = 0;
  let inputCells = 0;
  let labelCells = 0;

  for (const sheet of model.sheets) {
    let sheetFormula = 0;
    let sheetStatic = 0;

    for (const cell of sheet.cells) {
      switch (cell.kind) {
        case 'formula':
          sheetFormula += 1;
          break;
        case 'staticDerived':
          sheetStatic += 1;
          break;
        case 'input':
          inputCells += 1;
          break;
        case 'label':
        case 'header':
        case 'metadata':
          labelCells += 1;
          break;
      }
    }

    formulaCells += sheetFormula;
    staticDerivedCells += sheetStatic;
    const calculated = sheetFormula + sheetStatic;
    bySheet.push({
      sheet: sheet.name,
      calculatedCells: calculated,
      formulaCells: sheetFormula,
      staticDerivedCells: sheetStatic,
      formulaCoverage: calculated === 0 ? 1 : sheetFormula / calculated,
    });
  }

  bySheet.sort((a, b) => a.formulaCoverage - b.formulaCoverage);
  const calculatedCells = formulaCells + staticDerivedCells;

  return {
    calculatedCells,
    formulaCells,
    staticDerivedCells,
    formulaCoverage: calculatedCells === 0 ? 1 : formulaCells / calculatedCells,
    inputCells,
    labelCells,
    bySheet,
  };
}

/** A one-screen summary, for the export diagnostic and the CLI. */
export function formatCoverage(report: CoverageReport): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Calculated cells:     ${report.calculatedCells}`,
    `Formula cells:        ${report.formulaCells}`,
    `Static calculated:    ${report.staticDerivedCells}`,
    `Formula coverage:     ${percent(report.formulaCoverage)}`,
    '',
    'By sheet (weakest first):',
  ];
  for (const sheet of report.bySheet) {
    if (sheet.calculatedCells === 0) continue;
    lines.push(
      `  ${sheet.sheet.padEnd(16)} ${percent(sheet.formulaCoverage).padStart(7)} ` +
        `(${sheet.formulaCells}/${sheet.calculatedCells})`,
    );
  }
  return lines.join('\n');
}
