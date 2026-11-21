// solve.js v2 — fast dependency-free drop-in for csv-reader 1.0.0.
// Strategy: inline single loop, no regex, no per-field function calls.
// Common fields are handled with a few native indexOf/slice calls; every
// rare/broken shape (doubled quotes, embedded CR/LF in quotes, stray CR,
// junk after a closing quote, unterminated quote) falls back to a slow
// generic reader that mirrors the reference exactly. Pure: no clock,
// no randomness, no locale, no state between calls.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  let recordLine = 1;
  let recordRow = null;
  let ended = END;
  let added = 0;
  const SEP = /[,\r\n]/g;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Generic unquoted reader (rare path only): mirrors reference readUnquoted.
  function readUnquoted(value) {
    added = 0;
    for (;;) {
      SEP.lastIndex = pos;
      const m = SEP.exec(text);
      if (m === null) {
        if (pos < len) { value += text.slice(pos); added += len - pos; pos = len; }
        ended = END;
        return value;
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (i > pos) { value += text.slice(pos, i); added += i - pos; }
        pos = i + 1; ended = COMMA; return value;
      }
      if (c === '\n') {
        if (i > pos) { value += text.slice(pos, i); added += i - pos; }
        pos = i + 1; line += 1; ended = LINE_BREAK; return value;
      }
      if (text.charCodeAt(i + 1) === 10) {
        if (i > pos) { value += text.slice(pos, i); added += i - pos; }
        pos = i + 2; line += 1; ended = LINE_BREAK; return value;
      }
      err('stray_cr');
      if (i > pos) { value += text.slice(pos, i); added += i - pos; }
      pos = i + 1;
    }
  }

  function appendSegment(value, from, to) {
    const nl = text.indexOf('\n', from);
    if (nl !== -1 && nl < to) return appendBroken(value, from, to);
    const cr = text.indexOf('\r', from);
    if (cr !== -1 && cr < to) return appendBroken(value, from, to);
    return value + text.slice(from, to);
  }
  function appendBroken(value, from, to) {
    const s = text.slice(from, to);
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 10) n += 1;
      else if (c === 13) { n += 1; if (s.charCodeAt(i + 1) === 10) i += 1; }
    }
    line += n;
    return value + s.replace(/\r\n?/g, '\n');
  }

  // Generic quoted reader (rare path only): mirrors reference readQuoted.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        value = appendSegment(value, pos, q);
        value += '"';
        pos = q + 2;
        continue;
      }
      value = appendSegment(value, pos, q);
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      err('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= len) { ended = END; return value; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; ended = COMMA; return value; }
    if (c === 10) { pos += 1; line += 1; ended = LINE_BREAK; return value; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = LINE_BREAK; return value; }
    const junk = readUnquoted(value);
    if (added > 0) err('quote_junk');
    return junk;
  }

  function commitRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; return; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: quote-free line -> split at once.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? len : lf;
    const qp = text.indexOf('"', pos);
    if (qp === -1 || qp >= lineEnd) {
      const lineText = text.slice(pos, lineEnd);
      const r = lineText.indexOf('\r');
      if (r === -1) {
        commitRecord(lineText.split(','), false);
        pos = lf === -1 ? len : lf + 1;
        if (lf !== -1) line += 1;
        continue;
      }
      if (r === lineText.length - 1 && lf !== -1) {
        commitRecord(lineText.slice(0, -1).split(','), false);
        pos = lf + 1;
        line += 1;
        continue;
      }
      // stray CR in the line: fall through to the slow path.
    }

    const fields = [];
    let quoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        // Scan past doubled quotes to the closing quote.
        let start = pos + 1;
        let hasDbl = false;
        let q = -1;
        for (;;) {
          q = text.indexOf('"', start);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) { hasDbl = true; start = q + 2; continue; }
          break;
        }
        if (q !== -1) {
          const seg = text.slice(pos + 1, q);
          if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
            const val = hasDbl ? seg.replaceAll('""', '"') : seg;
            fields.push(val);
            pos = q + 1;
            if (pos >= len) { ended = END; }
            else {
              const cc = text.charCodeAt(pos);
              if (cc === 44) { pos += 1; ended = COMMA; }
              else if (cc === 10) { pos += 1; line += 1; ended = LINE_BREAK; }
              else if (cc === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = LINE_BREAK; }
              else {
                const junk = readUnquoted(val);
                if (added > 0) err('quote_junk');
                fields[fields.length - 1] = junk;
              }
            }
          } else {
            fields[fields.length]=readQuoted();
          }
        } else {
          fields[fields.length]=readQuoted();
        }
      } else {
        quoted = false;
        const c = text.indexOf(',', pos);
        const n = text.indexOf('\n', pos);
        if (c !== -1 && (n === -1 || c < n)) {
          const seg = text.slice(pos, c);
          if (seg.indexOf('\r') === -1) { fields[fields.length]=seg; pos = c + 1; ended = COMMA; }
          else fields[fields.length]=readUnquoted('');
        } else if (n !== -1) {
          const seg = text.slice(pos, n);
          if (seg.indexOf('\r') === -1) { fields[fields.length]=seg; pos = n + 1; line += 1; ended = LINE_BREAK; }
          else if (seg.indexOf('\r') === seg.length - 1) { fields.push(seg.slice(0, -1)); pos = n + 1; line += 1; ended = LINE_BREAK; }
          else fields[fields.length]=readUnquoted('');
        } else {
          const seg = text.slice(pos);
          if (seg.indexOf('\r') === -1) { fields[fields.length]=seg; pos = len; ended = END; }
          else fields[fields.length]=readUnquoted('');
        }
      }
      if (ended !== COMMA) break;
    }
    commitRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
