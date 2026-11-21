// csv-faster: a fast drop-in for make.fun's csv-reader 1.0.0.
//
// Same answer as csv-reader's readCsv for every input {text, header}:
// {columns, rows, errors}. Written from the reference's stated policy
// (RULES.txt) and checked against the reference itself, not copied from it:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character, and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings,
//     never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's
//     index in rows (null for the header), in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record ends.
//
// Speed: the reference reads one character at a time and builds every field a
// character at a time. This one jumps with indexOf instead: an unquoted field is
// one slice up to the next comma or LF (a stray CR inside it is stripped after
// the fact, and they are rare), a quoted field is one slice up to its closing
// quote (found by indexOf, skipping doubled quotes), with "" unescaping and
// CR-to-LF conversion only when the slice actually holds them. Pure: no state
// is kept from one call to the next.

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break or 2 at the end of the text (the record ends). */
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

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Records.
  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
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
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = COMMA;
    let lastQuoted = false;

    // Fields of this record.
    while (ended === COMMA) {
      let value = '';
      let junk = false; // this field's unquoted scan follows a closing quote
      lastQuoted = false;

      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote: run to the next quote that is not doubled.
        lastQuoted = true;
        let p = pos + 1;
        let close = -1;
        for (;;) {
          const q = text.indexOf('"', p);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            p = q + 2;
            continue;
          }
          close = q;
          break;
        }
        if (close === -1) {
          // The quote never closes: it is a literal character, and the text after
          // it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos += 1;
          value = '"';
          // Fall through to the unquoted scan below.
        } else {
          value = text.slice(pos + 1, close);
          if (value.indexOf('""') !== -1) value = value.replaceAll('""', '"');
          if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
            // Each CRLF or lone CR inside quotes is one LF, and each counts a line.
            let add = 0;
            let i = -1;
            while ((i = value.indexOf('\n', i + 1)) !== -1) add += 1;
            i = -1;
            while ((i = value.indexOf('\r', i + 1)) !== -1) {
              if (value.charCodeAt(i + 1) !== 10) add += 1;
            }
            line += add;
            value = value.replace(/\r\n?/g, '\n');
          }
          pos = close + 1;
          if (pos >= n) {
            fields.push(value);
            ended = END;
            continue;
          }
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            fields.push(value);
            ended = COMMA;
            continue;
          }
          if (c === 10) {
            pos += 1;
            line += 1;
            fields.push(value);
            ended = LINE_BREAK;
            continue;
          }
          if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fields.push(value);
            ended = LINE_BREAK;
            continue;
          }
          // What follows the closing quote is appended as it stands, up to the
          // next comma or line break: fall through to the unquoted scan.
          junk = true;
        }
      }

      // Read unquoted characters onto `value` up to the next comma or line break:
      // a CR not followed by LF is dropped (stray_cr). One slice to the next
      // comma or LF; a CR can only be the slice's last character when the next
      // character is the LF that ends it (a CRLF), every other CR in it is stray.
      let added = 0;
      for (;;) {
        let comma = text.indexOf(',', pos);
        if (comma === -1) comma = n;
        let nl = text.indexOf('\n', pos);
        if (nl === -1) nl = n;
        if (comma < nl) {
          let seg = text.slice(pos, comma);
          const cr = seg.indexOf('\r');
          if (cr !== -1) {
            let cnt = 0;
            for (let i = cr; i < seg.length; i++) {
              if (seg.charCodeAt(i) === 13) cnt += 1;
            }
            for (let i = 0; i < cnt; i++) {
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            }
            seg = seg.replaceAll('\r', '');
          }
          value += seg;
          added += seg.length;
          pos = comma + 1;
          ended = COMMA;
          break;
        }
        if (nl < n) {
          let seg = text.slice(pos, nl);
          // A trailing CR here is the CRLF's CR; any other CR in the slice is stray.
          let crlf = false;
          if (seg.charCodeAt(seg.length - 1) === 13) {
            crlf = true;
            seg = seg.slice(0, -1);
          }
          const cr = seg.indexOf('\r');
          if (cr !== -1) {
            let cnt = 0;
            for (let i = cr; i < seg.length; i++) {
              if (seg.charCodeAt(i) === 13) cnt += 1;
            }
            for (let i = 0; i < cnt; i++) {
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            }
            seg = seg.replaceAll('\r', '');
          }
          value += seg;
          added += seg.length;
          pos = nl + 1;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        // End of the text.
        let seg = text.slice(pos, n);
        const cr = seg.indexOf('\r');
        if (cr !== -1) {
          let cnt = 0;
          for (let i = cr; i < seg.length; i++) {
            if (seg.charCodeAt(i) === 13) cnt += 1;
          }
          for (let i = 0; i < cnt; i++) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          seg = seg.replaceAll('\r', '');
        }
        value += seg;
        added += seg.length;
        pos = n;
        ended = END;
        break;
      }
      if (junk && added > 0) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      fields.push(value);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
