// solve.js — a fast, dependency-free drop-in for csv-reader 1.0.0 (make.fun).
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. Written from the published broken-row policy, not from
// any other parser: a U+FEFF at the very start is dropped; a record ends at LF or
// CRLF and a line left with no characters is no record; outside quotes a CR not
// followed by LF is dropped (stray_cr); a field that opens with a quote runs to the
// next quote that is not doubled, "" inside it is one quote and each CRLF or lone
// CR inside it is read as LF; what follows its closing quote, up to the next comma
// or line break, is appended as it stands (quote_junk, when the field ends); a
// quote that never closes is a literal character and the text after it is read
// again as unquoted (unterminated_quote); a quote inside an unquoted field is a
// literal character; fields stay strings, never trimmed or converted; columns is
// the first record when header is true, else null; rows holds the records after
// it, each padded with "" (short_row) or cut (long_row) to the first record's
// width; each error is {code, line, row} in the order met.
//
// Speed comes from scanning with the engine's native search instead of reading
// one character at a time: unquoted fields are cut out with one regex scan for
// the next comma/CR/LF, quoted fields with indexOf for the next quote, and a
// whole record that holds no quote at all is split at once. Pure: no clock, no
// randomness, no locale, nothing kept from one call to the next.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the field just read ended, and how many characters its reader kept.
  let ended = END;
  let added = 0;

  // The next comma, CR or LF at or after pos.
  const SEP = /[,\r\n]/g;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Appends text[from..to) — a stretch with no quote in it — onto value, reading
  // each CRLF or lone CR inside it as one LF (and counting the lines it spans).
  function appendSegment(value, from, to) {
    const nl = text.indexOf('\n', from);
    if (nl !== -1 && nl < to) return appendBroken(value, from, to);
    const cr = text.indexOf('\r', from);
    if (cr !== -1 && cr < to) return appendBroken(value, from, to);
    return value + text.slice(from, to);
  }

  // The same stretch when it does hold a line break: normalize it and count lines.
  function appendBroken(value, from, to) {
    const s = text.slice(from, to);
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 10) n += 1;
      else if (c === 13) {
        n += 1;
        if (s.charCodeAt(i + 1) === 10) i += 1;
      }
    }
    line += n;
    return value + s.replace(/\r\n?/g, '\n');
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a
  // CR not followed by LF is dropped (stray_cr). Sets `ended` and `added`.
  function readUnquoted(value) {
    added = 0;
    for (;;) {
      SEP.lastIndex = pos;
      const m = SEP.exec(text);
      if (m === null) {
        if (pos < len) {
          value += text.slice(pos);
          added += len - pos;
          pos = len;
        }
        ended = END;
        return value;
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        ended = COMMA;
        return value;
      }
      if (c === '\n') {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      // A CR: CRLF ends the field, a lone CR is dropped (stray_cr).
      if (text.charCodeAt(i + 1) === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 2;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      err('stray_cr');
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      pos = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets `ended`.
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
        // A doubled quote is one quote inside the field.
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
      // The quote never closes: it is a literal character, and the text after it
      // is read again as unquoted.
      pos = open + 1;
      line = openLine;
      err('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= len) {
      ended = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = LINE_BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (added > 0) err('quote_junk');
    return junk;
  }

  // Files a finished record away: the header when it is the first, else a row
  // padded or cut to the first record's width. A line that held only stray CRs
  // is left with no characters: no record (its stray_cr errors stay).
  function commitRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this record's line holds no quote at all, so no field in it
    // is quoted and none spans a line: split the whole line at once.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? len : lf;
    const lineText = text.slice(pos, lineEnd);
    if (lineText.indexOf('"') === -1) {
      const r = lineText.indexOf('\r');
      if (r === -1) {
        commitRecord(lineText.split(','), false);
        pos = lf === -1 ? len : lf + 1;
        if (lf !== -1) line += 1;
        continue;
      }
      if (r === lineText.length - 1 && lf !== -1) {
        // The line's only CR is the CRLF that ends it.
        commitRecord(lineText.slice(0, -1).split(','), false);
        pos = lf + 1;
        line += 1;
        continue;
      }
      // A stray CR sits inside the line: fall through to the slow path.
    }

    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === COMMA);
    commitRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
