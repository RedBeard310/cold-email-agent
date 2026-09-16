// The consulti:prune archives, read back so a load never adds a pruned lead again.
//
// consulti:prune deletes leads that shouldn't get an email: shared inboxes like info@, a second
// contact at the same firm, parked domains, and a few more (the list is at the top of prune.ts).
// Before it deletes anything, it lists each of those leads in consulti-pruned-<date>.csv in the
// folder it runs from. The CSVs that consulti:to-db and apollo:to-db load still hold those leads, so
// both commands read the archives from the current folder and skip any new row whose email is listed.
//
// The archive files are gitignored lead data. They exist only on the machine where prune ran, and git
// keeps no copy, so don't delete them.
//
// The archives list emails, not Apollo person ids, so a new row with no email can't be checked.
import fs from 'node:fs';
import path from 'node:path';

/** Archive file names as consulti:prune writes them, including the -2, -3 suffix of a same-day re-run. */
export const PRUNE_ARCHIVE_FILE = /^consulti-pruned-.*\.csv$/;

export interface PruneArchive {
  /** The folder that was searched, as an absolute path. */
  dir: string;
  /** The archive files found there, by name. Empty when there are none. */
  files: string[];
  /** Every email the archives list, lowercase and trimmed. */
  emails: Set<string>;
}

/** Read every prune archive in `dir` (default: the current folder). */
export function readPruneArchive(dir = '.'): PruneArchive {
  const abs = path.resolve(dir);
  const files = fs.readdirSync(abs).filter((name) => PRUNE_ARCHIVE_FILE.test(name)).sort();
  const emails = new Set<string>();
  for (const file of files) {
    const [header, ...rows] = csvRows(fs.readFileSync(path.join(abs, file), 'utf8'));
    if (!header) continue; // an empty file lists nobody
    const col = header.indexOf('email');
    if (col < 0) throw new Error(`${file} has no email column. Is it a consulti:prune archive?`);
    for (const row of rows) {
      const email = (row[col] ?? '').trim().toLowerCase();
      if (email) emails.add(email);
    }
  }
  return { dir: abs, files, emails };
}

/** The reason a load must stop before adding `added` new leads, or null when it can go ahead.
 *  `archive` is null when --skip-prune-check switched the check off. */
export function pruneCheckRefusal(archive: PruneArchive | null, added: number): string | null {
  if (!archive || archive.files.length > 0 || added === 0) return null;
  return (
    `refusing to add ${added} new lead(s): there's no consulti:prune archive (consulti-pruned-*.csv) in ${archive.dir}. ` +
    "Without one, this load can't tell which leads were deleted on purpose, and it would add them back. " +
    'Run it from the folder that holds the archives, or pass --skip-prune-check to add them without the check. Nothing was written.'
  );
}

/** Split CSV text into rows of fields. Handles quoted commas, doubled quotes, embedded newlines and
 *  CRLF, and drops blank lines, the same way parseCsv in pull.ts does. pull.ts can't be imported here:
 *  it loads the Consulti client, which loads src/env.ts, and that throws when SMARTLEAD_API_KEY is
 *  missing. apollo:to-db shouldn't need the SmartLead key. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }
  return rows;
}
