import { parse } from 'csv-parse/sync';

const DATE_LIKE = /^\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseCsvRows(csvText) {
  return parse(csvText, {
    skip_empty_lines: false,
    relax_quotes: true
  });
}

function flattenDataRows(rows) {
  return rows.slice(1).flatMap((row) => row.map((cell) => String(cell ?? '').trim()));
}

function wantsDuplicateRemoval(task) {
  return /\b(dedupe|dedup|duplicate|duplicates|remove duplicate)\b/i.test(task || '');
}

function wantsDateNormalization(task) {
  return /\b(date|dates|timestamp|normalize date|standardize date|yyyy-mm-dd|iso)\b/i.test(task || '');
}

export function getInputRowCount(csvText) {
  const rows = parseCsvRows(csvText);
  return Math.max(rows.length - 1, 0);
}

export function validateDynamicCsvResult({ task, inputCsv, outputCsv }) {
  const warnings = [];
  const failures = [];

  let inputRows;
  let outputRows;

  try {
    inputRows = parseCsvRows(inputCsv);
  } catch (error) {
    return {
      passed: false,
      warnings: ['Input CSV could not be parsed for backend validation.'],
      failures: [`Input CSV parsing failed: ${error.message}`],
      rows_input: 0,
      rows_output: 0,
      duplicates_removed: null,
      dates_normalized: null
    };
  }

  try {
    outputRows = parseCsvRows(outputCsv);
  } catch (error) {
    return {
      passed: false,
      warnings,
      failures: [`Output CSV parsing failed: ${error.message}`],
      rows_input: Math.max(inputRows.length - 1, 0),
      rows_output: 0,
      duplicates_removed: null,
      dates_normalized: null
    };
  }

  const rowsInput = Math.max(inputRows.length - 1, 0);
  const rowsOutput = Math.max(outputRows.length - 1, 0);

  if (!outputCsv.trim()) {
    failures.push('Output CSV is empty.');
  }

  const outputHeader = Array.isArray(outputRows?.[0]) ? outputRows[0] : [];
  const hasHeaderRow =
    outputHeader.length > 0 && outputHeader.some((cell) => String(cell ?? '').trim().length > 0);
  if (!hasHeaderRow) {
    failures.push('Output CSV header row is missing or empty.');
  }

  if (rowsOutput === 0) {
    failures.push('Output CSV has no data rows.');
  }

  const inputDataRows = inputRows.slice(1);
  const outputDataRows = outputRows.slice(1);
  const inputDeduped = new Set(inputDataRows.map((row) => JSON.stringify(row))).size;
  const outputDeduped = new Set(outputDataRows.map((row) => JSON.stringify(row))).size;

  const requestedDuplicateRemoval = wantsDuplicateRemoval(task);
  if (requestedDuplicateRemoval && outputDeduped !== outputDataRows.length) {
    failures.push('Duplicate rows still present in output while task requested duplicate removal.');
  }

  const duplicatesRemoved = Math.max(inputDataRows.length - outputDataRows.length, 0);

  const requestedDateNormalization = wantsDateNormalization(task);
  let datesNormalized = null;

  if (requestedDateNormalization) {
    const inputCells = flattenDataRows(inputRows);
    const outputCells = flattenDataRows(outputRows);

    const inputDateLike = inputCells.filter((cell) => DATE_LIKE.test(cell));
    const outputIsoLike = outputCells.filter((cell) => ISO_DATE.test(cell));

    datesNormalized = Math.max(outputIsoLike.length - inputCells.filter((cell) => ISO_DATE.test(cell)).length, 0);

    if (inputDateLike.length > 0 && outputIsoLike.length === 0) {
      failures.push('Date normalization appears to have failed (no ISO-like dates found in output).');
    }

    if (inputDateLike.length === 0) {
      warnings.push('Task requested date normalization, but no obvious date-like values were found in input.');
    }
  }

  if (rowsOutput > rowsInput && rowsInput > 0) {
    warnings.push('Output row count is greater than input row count. Verify if row expansion was intended.');
  }

  if (requestedDuplicateRemoval && duplicatesRemoved === 0 && inputDataRows.length !== inputDeduped) {
    warnings.push('Possible duplicates existed in input, but none were removed.');
  }

  return {
    passed: failures.length === 0,
    warnings,
    failures,
    rows_input: rowsInput,
    rows_output: rowsOutput,
    cleaned_csv_header_detected: hasHeaderRow,
    duplicates_removed: requestedDuplicateRemoval ? duplicatesRemoved : null,
    dates_normalized: requestedDateNormalization ? datesNormalized ?? 0 : null
  };
}
