'use strict';

// Minimal reader for Excel 97–2003 (.xls, BIFF8) workbooks: returns each sheet's cell values
// (text, numbers, booleans). Formatting, formulas' expressions and charts are ignored.
// The OLE container is parsed by SheetJS's `cfb`; the BIFF8 records are decoded here.
const CFB = require('cfb');

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
};

function readRecords(buf) {
  const out = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const type = buf.readUInt16LE(pos);
    const len = buf.readUInt16LE(pos + 2);
    out.push({ type, pos, data: buf.subarray(pos + 4, Math.min(buf.length, pos + 4 + len)) });
    pos += 4 + len;
  }
  return out;
}

// Reads a string body (after cch) whose characters may continue into following CONTINUE
// segments; each continuation starts with a fresh "high byte" flag.
class SegmentReader {
  constructor(segments) {
    this.segs = segments;
    this.i = 0;
    this.off = 0;
  }
  ensure() {
    while (this.i < this.segs.length && this.off >= this.segs[this.i].length) {
      this.i++;
      this.off = 0;
    }
    if (this.i >= this.segs.length) throw new Error('Unexpected end of shared string table');
  }
  bytes(n) {
    const parts = [];
    while (n > 0) {
      this.ensure();
      const seg = this.segs[this.i];
      const take = Math.min(n, seg.length - this.off);
      parts.push(seg.subarray(this.off, this.off + take));
      this.off += take;
      n -= take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }
  u8() {
    return this.bytes(1)[0];
  }
  u16() {
    return this.bytes(2).readUInt16LE(0);
  }
  i32() {
    return this.bytes(4).readInt32LE(0);
  }
  chars(cch, highByte) {
    let s = '';
    let remaining = cch;
    let wide = highByte;
    while (remaining > 0) {
      this.ensure();
      const seg = this.segs[this.i];
      const avail = Math.floor((seg.length - this.off) / (wide ? 2 : 1));
      const take = Math.min(remaining, avail);
      if (take > 0) {
        const raw = seg.subarray(this.off, this.off + take * (wide ? 2 : 1));
        s += wide ? raw.toString('utf16le') : raw.toString('latin1');
        this.off += raw.length;
        remaining -= take;
      }
      if (remaining > 0) {
        // Characters continue in the next CONTINUE record, which begins with a new flags byte.
        this.i++;
        this.off = 0;
        this.ensure();
        wide = (this.u8() & 0x01) === 1;
      }
    }
    return s;
  }
}

// XLUnicodeRichExtendedString (SST entries).
function readRichString(r) {
  const cch = r.u16();
  const flags = r.u8();
  const runs = flags & 0x08 ? r.u16() : 0;
  const ext = flags & 0x04 ? r.i32() : 0;
  const s = r.chars(cch, (flags & 0x01) === 1);
  if (runs) r.bytes(runs * 4);
  if (ext > 0) r.bytes(ext);
  return s;
}

// XLUnicodeString (LABEL / STRING records, never split).
function readUnicodeString(data, off) {
  const cch = data.readUInt16LE(off);
  const wide = (data[off + 2] & 0x01) === 1;
  const raw = data.subarray(off + 3, off + 3 + cch * (wide ? 2 : 1));
  return wide ? raw.toString('utf16le') : raw.toString('latin1');
}

function rkValue(rk) {
  let v;
  if (rk & 0x02) {
    v = rk >> 2; // signed 30-bit integer
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(rk & 0xfffffffc, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

function readSst(records, idx) {
  const segments = [records[idx].data.subarray(8)];
  const unique = records[idx].data.readUInt32LE(4);
  for (let j = idx + 1; j < records.length && records[j].type === R.CONTINUE; j++) segments.push(records[j].data);
  const r = new SegmentReader(segments);
  const strings = [];
  for (let n = 0; n < unique; n++) strings.push(readRichString(r));
  return strings;
}

function readWorkbook(input) {
  let container;
  try {
    container = CFB.read(input, { type: 'buffer' });
  } catch {
    throw new Error('This file is not an Excel .xls workbook.');
  }
  const stream = CFB.find(container, 'Workbook') || CFB.find(container, 'Book');
  if (!stream || !stream.content) throw new Error('No workbook data found in this .xls file.');
  if (stream.name === 'Book') throw new Error('This is an old Excel 5/95 file. Re-save it as Excel 97–2003 (.xls) or CSV.');
  const buf = Buffer.from(stream.content);
  const records = readRecords(buf);

  const sheetsByPos = new Map();
  const order = [];
  let sst = [];
  for (let i = 0; i < records.length; i++) {
    const { type, data } = records[i];
    if (type === R.FILEPASS) throw new Error('This workbook is password protected. Remove the password and try again.');
    if (type === R.BOUNDSHEET) {
      const pos = data.readUInt32LE(0);
      const kind = data[5]; // 0 = worksheet
      const cch = data[6];
      const wide = (data[7] & 0x01) === 1;
      const raw = data.subarray(8, 8 + cch * (wide ? 2 : 1));
      const sheet = { name: wide ? raw.toString('utf16le') : raw.toString('latin1'), kind, rows: [] };
      sheetsByPos.set(pos, sheet);
      order.push(sheet);
    } else if (type === R.SST) {
      sst = readSst(records, i);
    } else if (type === R.EOF) {
      break; // end of the globals substream
    }
  }

  let current = null;
  let pendingFormula = null;
  const set = (row, col, value) => {
    if (!current) return;
    while (current.rows.length <= row) current.rows.push([]);
    const r = current.rows[row];
    while (r.length < col) r.push(null);
    r[col] = value;
  };
  for (const rec of records) {
    const { type, data } = rec;
    if (type === R.BOF) {
      current = sheetsByPos.get(rec.pos) || null;
      continue;
    }
    if (!current) continue;
    switch (type) {
      case R.EOF:
        current = null;
        break;
      case R.LABELSST:
        set(data.readUInt16LE(0), data.readUInt16LE(2), sst[data.readUInt32LE(6)] ?? '');
        break;
      case R.LABEL:
        set(data.readUInt16LE(0), data.readUInt16LE(2), readUnicodeString(data, 6));
        break;
      case R.NUMBER:
        set(data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6));
        break;
      case R.RK:
        set(data.readUInt16LE(0), data.readUInt16LE(2), rkValue(data.readUInt32LE(6)));
        break;
      case R.MULRK: {
        const row = data.readUInt16LE(0);
        const first = data.readUInt16LE(2);
        const n = (data.length - 6) / 6;
        for (let k = 0; k < n; k++) set(row, first + k, rkValue(data.readUInt32LE(4 + k * 6 + 2)));
        break;
      }
      case R.BOOLERR:
        if (data[7] === 0) set(data.readUInt16LE(0), data.readUInt16LE(2), data[6] === 1);
        break;
      case R.FORMULA: {
        const row = data.readUInt16LE(0);
        const col = data.readUInt16LE(2);
        if (data.readUInt16LE(12) === 0xffff) {
          if (data[6] === 0) pendingFormula = { row, col }; // string result follows in a STRING record
          else if (data[6] === 1) set(row, col, data[8] === 1);
        } else {
          set(row, col, data.readDoubleLE(6));
        }
        break;
      }
      case R.STRING:
        if (pendingFormula) set(pendingFormula.row, pendingFormula.col, readUnicodeString(data, 0));
        pendingFormula = null;
        break;
      default:
        break;
    }
  }
  return order.filter((s) => s.kind === 0).map(({ name, rows }) => ({ name, rows }));
}

// Converts an Excel date serial (1900 system) to YYYY-MM-DD.
function excelSerialToISO(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

module.exports = { readWorkbook, excelSerialToISO };
