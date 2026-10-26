'use strict';

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// Rows of values → CSV text, with a byte-order mark so Excel opens it as UTF-8.
function toCsv(rows) {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { csvCell, toCsv };
