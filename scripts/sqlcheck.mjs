#!/usr/bin/env node
// Parse every supabase/migrations/*.sql with the REAL PostgreSQL grammar (libpg_query, via pglast).
//
// WHY THIS EXISTS. Migrations in this repo are handed to the owner as copy-paste SQL and applied by hand in
// the Supabase dashboard, so a syntax error is not caught by CI, not caught by a reviewer, and not caught
// until the owner pastes it and reads an error message. That has happened. Nothing else in the pipeline looks
// at a .sql file at all: scripts/typecheck.mjs covers index.html, typecheck-functions.mjs covers the edge
// functions, and the selftest suite runs in a browser.
//
// WHAT IT CATCHES (each of these was planted and confirmed to fail before this script was trusted):
//   * outer statement syntax           -- create TABEL ...
//   * plpgsql control flow             -- a missing `end loop;`, `foreach x ON array y`
//   * undeclared plpgsql variables     -- assigning to a name that is not in the declare block
//   * `:=` used inside a SQL select list, and unbalanced parentheses in a function body
//
// WHAT IT DOES NOT CATCH, stated plainly so this is not mistaken for coverage:
//   * ANYTHING SEMANTIC. A column, table or function that does not exist parses perfectly. The two real
//     errors shipped in a verify block (player_items has no `synced_at`; the Signet key doubles its layer
//     prefix) were both semantic and would both still slip through. Only a live database catches those.
//   * ANYTHING IN A `--` COMMENT. The runbook and verify blocks at the bottom of every migration are comments,
//     so they are not parsed. That is exactly where those two errors lived. Read them by hand.
//   * SQL expressions embedded in a plpgsql body. libpg_query defers those to runtime, as PostgreSQL does.
//
// REQUIREMENT: python3 with pglast (`pip install pglast`). Missing it is a hard FAILURE, not a skip -- a
// guard that silently passes when its engine is absent is worse than no guard, which is the standing rule in
// CLAUDE.md. It is wired into tests.yml only, NOT pages.yml: installing from PyPI on the deploy path would
// let a package-index outage block a publish, and this check gates nothing the browser suite covers.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'supabase', 'migrations');

let files;
try {
  files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
} catch (e) {
  console.error(`sqlcheck: cannot read ${DIR}: ${e.message}`);
  process.exit(1);
}
if (!files.length) { console.error('sqlcheck: no migrations found -- refusing to report success'); process.exit(1); }

// The checker runs in python because libpg_query's only maintained binding here is pglast. It reports one
// line per failing file and exits non-zero; a clean run prints a count.
const PY = `
import sys, json
try:
    from pglast import parser
    from pglast.parser import ParseError
except Exception as e:
    sys.stderr.write('sqlcheck: pglast is not installed (%s).\\n' % e)
    sys.stderr.write('sqlcheck: install it with:  pip install pglast\\n')
    sys.exit(2)

bad = 0
for path in sys.argv[1:]:
    with open(path) as fh: sql = fh.read()
    errs = []
    try: parser.parse_sql(sql)
    except ParseError as e: errs.append('statement: ' + str(e).split('\\n')[0])
    try:
        # Function bodies are string literals to the statement parser, so plpgsql needs its own pass.
        # Only ParseError counts: libpg_query's plpgsql dump is not always valid JSON (embedded newlines),
        # which is a serialization quirk in the dump, NOT a problem with the SQL.
        parser.parse_plpgsql_json(sql)
    except ParseError as e: errs.append('plpgsql: ' + str(e).split('\\n')[0])
    if errs:
        bad += 1
        print('FAIL ' + path.rsplit('/', 1)[-1])
        for e in errs: print('       ' + e)
print('%d migrations parsed, %d with syntax errors' % (len(sys.argv) - 1, bad))
sys.exit(1 if bad else 0)
`;

const r = spawnSync('python3', ['-c', PY, ...files.map(f => join(DIR, f))],
                    { cwd: ROOT, encoding: 'utf8' });
if (r.error) {
  console.error(`sqlcheck: could not run python3: ${r.error.message}`);
  process.exit(1);
}
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);
