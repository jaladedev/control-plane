#!/usr/bin/env bash
# Restore drill (plan M6): proves a backup can be turned back into a working
# database. Run it on YOUR machine, where the offline age private key is. The
# control plane never has that key, so it can only be told the result
# (dashboard: the school's page, "Restore drills").
#
# What it does, timing each step: (fetch) -> checksum -> decrypt -> list ->
# restore into a SCRATCH Postgres -> check -> (compare with the live source) ->
# drop the scratch database. The plaintext dump lives only in a private temp
# directory and is deleted on exit, however the script ends.
#
# Environment:
#   AGE_IDENTITY     path to the age PRIVATE key file (required)
#   DRILL_FILE       the downloaded <...>.dump.age file, OR
#   OBJECT_KEY       the object to download, with R2_ENDPOINT, R2_BUCKET,
#                    R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (needs the aws CLI)
#   EXPECTED_SHA256  the checksum recorded for this backup (the `backups` table
#                    has it for school backups). Required.
#   KIND             school (default) or control-plane: which tables must exist
#   PGHOST PGPORT PGUSER PGPASSWORD
#                    the SCRATCH Postgres server (libpq's own variables). A new
#                    database is created there and dropped at the end. Hosts on
#                    supabase.co/.com or a pooler are REFUSED: a restore never
#                    targets a live project.
#   SOURCE_URL       optional: the live database's connection string, read-only.
#                    Row counts are shown side by side; they are not a pass/fail
#                    (a live database moves on after its backup was taken).
#   ALLOW_RESTORE_ERRORS=1   accept a pg_restore that reported errors (a dump
#                    from Supabase may name roles or extensions a plain Postgres
#                    lacks); the checks below still must pass.
#
# Needs age, pg_restore, psql (and aws only for OBJECT_KEY). Never prints a key.
# Exit 0: the drill passed. Exit 1: it did not, and the last line says why.
set -euo pipefail

fail() { echo "FAILED: $1" >&2; printf 'DRILL {"ok":false,"reason":"%s"}\n' "${1//\"/\'}"; exit 1; }

: "${AGE_IDENTITY:?Set AGE_IDENTITY (path to the age private key)}"
[ -r "$AGE_IDENTITY" ] || fail "cannot read AGE_IDENTITY"
: "${EXPECTED_SHA256:?Set EXPECTED_SHA256 (the checksum recorded for this backup)}"
[[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "EXPECTED_SHA256 must be 64 lowercase hex characters"
KIND="${KIND:-school}"
case "$KIND" in school | control-plane) ;; *) fail "KIND must be school or control-plane" ;; esac

host="${PGHOST:-localhost}"
if [[ "$host" =~ (supabase\.(co|com)|pooler) ]]; then
  fail "PGHOST ($host) is a Supabase host. Restore into a scratch Postgres, never a live project."
fi
case "$KIND" in
  school) EXPECT_TABLES="profiles school_settings" ;;
  control-plane) EXPECT_TABLES="dashboard_users audit_log schools" ;;
esac

work="$(mktemp -d)"; chmod 700 "$work"
db="drill_$(date -u +%Y%m%d%H%M%S)_$$"
created=0
cleanup() {
  rm -rf "$work"                                   # the plaintext never outlives the script
  if [ "$created" = 1 ]; then psql -qAt -d postgres -c "drop database if exists \"$db\"" > /dev/null 2>&1 || true; fi
}
trap cleanup EXIT

t0=$SECONDS
step_start=$SECONDS
mark() { echo "  $1: $((SECONDS - step_start))s"; }
begin() { step_start=$SECONDS; echo "$1..."; }

# 1. the encrypted dump
enc="${DRILL_FILE:-}"
if [ -z "$enc" ]; then
  : "${OBJECT_KEY:?Set DRILL_FILE or OBJECT_KEY}"
  : "${R2_ENDPOINT:?Set R2_ENDPOINT}" "${R2_BUCKET:?Set R2_BUCKET}"
  : "${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID}" "${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY}"
  [[ "$OBJECT_KEY" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*\.dump\.age$ ]] || fail "OBJECT_KEY looks wrong"
  begin "Downloading"
  enc="$work/backup.dump.age"
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
    aws s3 cp --only-show-errors --endpoint-url "$R2_ENDPOINT" "s3://$R2_BUCKET/$OBJECT_KEY" "$enc" \
    || fail "download failed"
  mark fetch
fi
[ -s "$enc" ] || fail "the encrypted dump is missing or empty"

# 2. the checksum recorded when the backup was taken
begin "Checking the checksum"
actual="$(sha256sum "$enc" | cut -d' ' -f1)"
[ "$actual" = "$EXPECTED_SHA256" ] || fail "checksum mismatch: the file is $actual, the record says $EXPECTED_SHA256"
mark checksum

# 3. decrypt with the offline key
begin "Decrypting"
age -d -i "$AGE_IDENTITY" -o "$work/restore.dump" "$enc" 2> "$work/age.err" \
  || fail "could not decrypt (wrong key?): $(tail -1 "$work/age.err")"
mark decrypt

# 4. look before restoring
begin "Listing the dump"
pg_restore --list "$work/restore.dump" > "$work/list.txt" 2> "$work/list.err" \
  || fail "the dump cannot be read: $(tail -1 "$work/list.err")"
entries="$(grep -c '^[0-9]' "$work/list.txt" || true)"
[ "$entries" -gt 0 ] || fail "the dump lists nothing"
mark list

# 5. restore into a fresh scratch database
begin "Restoring into scratch database $db on $host"
psql -qAt -d postgres -c "create database \"$db\"" > /dev/null || fail "cannot create a scratch database on $host"
created=1
restore_errors=0
pg_restore --clean --if-exists --no-owner --dbname="$db" "$work/restore.dump" 2> "$work/restore.err" || restore_errors=1
if [ "$restore_errors" = 1 ]; then
  echo "  pg_restore reported errors (last lines):" >&2
  tail -3 "$work/restore.err" >&2
  [ "${ALLOW_RESTORE_ERRORS:-0}" = 1 ] || fail "pg_restore reported errors (set ALLOW_RESTORE_ERRORS=1 to accept harmless ones)"
fi
mark restore

# 6. is it a working database?
begin "Checking the restored database"
q() { psql -qAt -d "$db" -c "$1"; }
tables="$(q "select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")"
[ "$tables" -gt 0 ] || fail "the restored database has no tables in public"
for t in $EXPECT_TABLES; do
  [ "$(q "select to_regclass('public.$t') is not null")" = "t" ] || fail "the restored database has no table $t"
done
latest="none"
if [ "$KIND" = school ]; then
  [ "$(q "select to_regclass('supabase_migrations.schema_migrations') is not null")" = "t" ] \
    || fail "the restored database has no migration history, so the control plane could not tell what it has"
  n="$(q "select count(*) from supabase_migrations.schema_migrations")"
  [ "$n" -gt 0 ] || fail "the restored migration history is empty"
  latest="$(q "select max(version) from supabase_migrations.schema_migrations")"
fi
mark check

# 7. side by side with the live source (information only)
if [ -n "${SOURCE_URL:-}" ]; then
  begin "Comparing row counts with the source"
  printf '  %-34s %10s %10s %8s\n' table restored source delta
  for t in $(q "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"); do
    r="$(q "select count(*) from public.\"$t\"")"
    s="$(psql -qAt "$SOURCE_URL" -c "select count(*) from public.\"$t\"" 2> /dev/null || echo '?')"
    if [[ "$s" =~ ^[0-9]+$ ]]; then d=$((s - r)); else d='?'; fi
    printf '  %-34s %10s %10s %8s\n' "$t" "$r" "$s" "$d"
  done
  echo "  (A source that moved on after the backup shows a positive delta. That is expected.)"
  mark compare
fi

total=$((SECONDS - t0))
echo "PASSED in ${total}s: $tables tables restored, latest migration $latest, restore errors: $restore_errors"
printf 'DRILL {"ok":true,"seconds":%s,"tables":%s,"latest_migration":"%s","restore_errors":%s}\n' \
  "$total" "$tables" "$latest" "$restore_errors"
echo "Record it: school page > Restore drills > $(( (total + 59) / 60 )) minute(s), result OK."
