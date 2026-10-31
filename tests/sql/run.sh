#!/usr/bin/env bash
# Replays every migration on a scratch Postgres database, then runs the SQL
# tests. Needs a throwaway Postgres you can create databases on. Set PSQL to the
# psql command with connection options, for example:
#   PSQL="psql -h localhost -U postgres" bash tests/sql/run.sh
# Exits non-zero if anything fails.
set -euo pipefail
cd "$(dirname "$0")/../.."
PSQL="${PSQL:-psql}"
DB=control_plane_test

$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
$PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/sql/prelude.sql >/dev/null
for f in $(ls supabase/migrations/*.sql | sort); do
  echo "migrate $f"
  $PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done

# Runs one SQL test file and fails the script unless it prints its PASSED line.
# (psql with ON_ERROR_STOP stops at the first error, so a failing test never
# reaches that line.)
run_suite() {
  local file="$1" out
  if ! out=$($PSQL -q -v ON_ERROR_STOP=1 -d "$DB" -f "$file" 2>&1); then
    echo "$out" | grep -E "ERROR|FAILED" || echo "$out" | tail -20
    echo "FAILED: $file" >&2
    exit 1
  fi
  if ! echo "$out" | grep -E "PASSED"; then
    echo "FAILED: $file finished without a PASSED line" >&2
    exit 1
  fi
}

run_suite tests/sql/foundations.test.sql
run_suite tests/sql/m1.test.sql
run_suite tests/sql/m2.test.sql
run_suite tests/sql/m4.test.sql
run_suite tests/sql/m4b.test.sql
run_suite tests/sql/m4c.test.sql
run_suite tests/sql/m2b.test.sql
run_suite tests/sql/m5.test.sql
run_suite tests/sql/m6.test.sql
run_suite tests/sql/provisioning.test.sql
run_suite tests/sql/m6b.test.sql
