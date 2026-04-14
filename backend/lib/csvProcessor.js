import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const NULL_LIKE_VALUES = new Set(['null', 'n/a', 'na']);

function isMissingValue(value) {
  if (value === '') return true;
  const lowered = value.toLowerCase();
  return NULL_LIKE_VALUES.has(lowered);
}

function pad(num) {
  return String(num).padStart(2, '0');
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function toIsoDate(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseSupportedDate(value) {
  const isoSlash = /^(\d{4})\/(\d{2})\/(\d{2})$/;
  const isoDash = /^(\d{4})-(\d{2})-(\d{2})$/;
  const mdy = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/;

  let match = value.match(isoSlash);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isValidDateParts(year, month, day)) return null;
    return toIsoDate(year, month, day);
  }

  match = value.match(isoDash);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isValidDateParts(year, month, day)) return null;
    return toIsoDate(year, month, day);
  }

  match = value.match(mdy);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!isValidDateParts(year, month, day)) return null;
    return toIsoDate(year, month, day);
  }

  match = value.match(dmy);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    if (!isValidDateParts(year, month, day)) return null;
    return toIsoDate(year, month, day);
  }

  return null;
}

function looksDateLike(value) {
  return /^\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}$/.test(value);
}

function normalizeHeader(header, idx) {
  const cleaned = String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

  return cleaned || `column_${idx + 1}`;
}

function dedupeHeaders(headers) {
  const seen = new Map();
  return headers.map((header) => {
    const count = seen.get(header) || 0;
    seen.set(header, count + 1);
    if (count === 0) return header;
    return `${header}_${count + 1}`;
  });
}

export function processCsv(csvText, plan) {
  if (!csvText || !csvText.trim()) {
    throw new Error('Uploaded CSV file is empty.');
  }

  let rows;
  try {
    rows = parse(csvText, {
      skip_empty_lines: false,
      relax_quotes: true
    });
  } catch (error) {
    throw new Error(`Invalid CSV format: ${error.message}`);
  }

  if (!rows.length) {
    throw new Error('Uploaded CSV file is empty.');
  }

  const headerRow = rows[0];
  if (!Array.isArray(headerRow) || headerRow.length === 0) {
    throw new Error('CSV must contain a header row.');
  }

  const expectedWidth = headerRow.length;
  const inconsistent = rows.findIndex((row, idx) => idx > 0 && row.length !== expectedWidth);
  if (inconsistent !== -1) {
    throw new Error(
      `CSV has inconsistent row shape at line ${inconsistent + 1}. Expected ${expectedWidth} fields.`
    );
  }

  const normalizedHeaders = dedupeHeaders(headerRow.map((header, idx) => normalizeHeader(header, idx)));
  const rowsInput = Math.max(rows.length - 1, 0);
  const warnings = [];
  const dateColumnsDetected = new Set();
  const dateColumnsNormalized = new Set();

  let datesNormalized = 0;
  let missingValuesDetected = 0;

  const transformedRows = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const transformed = row.map((cell, colIndex) => {
      const raw = String(cell ?? '').trim();
      const colName = normalizedHeaders[colIndex];

      if (isMissingValue(raw)) {
        missingValuesDetected += 1;
        if (plan.flag_missing_dates && dateColumnsDetected.has(colName)) {
          return 'MISSING';
        }
        return '';
      }

      const parsedDate = parseSupportedDate(raw);
      if (parsedDate) {
        dateColumnsDetected.add(colName);
        if (plan.standardize_dates) {
          if (parsedDate !== raw) {
            datesNormalized += 1;
            dateColumnsNormalized.add(colName);
          }
          return parsedDate;
        }
      } else if (looksDateLike(raw)) {
        warnings.push(
          `Row ${rowIndex + 1}, column "${colName}" has ambiguous or invalid date value "${raw}".`
        );
      }

      return raw;
    });

    transformedRows.push(transformed);
  }

  // Second pass for date-missing flagging after date columns are inferred.
  if (plan.flag_missing_dates && dateColumnsDetected.size > 0) {
    for (let r = 0; r < transformedRows.length; r += 1) {
      for (let c = 0; c < transformedRows[r].length; c += 1) {
        const colName = normalizedHeaders[c];
        if (!dateColumnsDetected.has(colName)) continue;

        const originalValue = String(rows[r + 1][c] ?? '').trim();
        if (isMissingValue(originalValue)) {
          transformedRows[r][c] = 'MISSING';
          warnings.push(`Row ${r + 2}, column "${colName}" had missing date value and was flagged.`);
        }
      }
    }
  }

  let duplicatesRemoved = 0;
  const dedupedRows = [];

  if (plan.remove_duplicates) {
    const seen = new Set();
    for (const row of transformedRows) {
      const key = JSON.stringify(row);
      if (seen.has(key)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(key);
      dedupedRows.push(row);
    }
  } else {
    dedupedRows.push(...transformedRows);
  }

  const csvOutput = stringify([normalizedHeaders, ...dedupedRows]);

  const missingValuesRemaining = dedupedRows.reduce((count, row) => {
    return count + row.filter((value) => value === '' || value === 'MISSING').length;
  }, 0);

  const metadata = {
    execution_mode: 'real_csv_processing',
    rows_input: rowsInput,
    rows_output: dedupedRows.length,
    columns_detected: normalizedHeaders,
    duplicates_removed: duplicatesRemoved,
    date_columns_detected: Array.from(dateColumnsDetected),
    dates_normalized: datesNormalized,
    missing_values_detected: missingValuesDetected,
    warnings,
    transformations_applied: [
      'Trimmed whitespace in headers and values',
      'Normalized headers (lowercase + underscores)',
      ...(plan.remove_duplicates ? ['Removed exact duplicate rows'] : []),
      ...(plan.standardize_dates ? ['Standardized detected dates to YYYY-MM-DD'] : [])
    ],
    validation_passed:
      rowsInput >= dedupedRows.length && duplicatesRemoved === rowsInput - dedupedRows.length,
    validation: {
      missing_values_remaining: missingValuesRemaining,
      date_columns_normalized: Array.from(dateColumnsNormalized)
    }
  };

  return {
    csvOutput,
    metadata
  };
}
