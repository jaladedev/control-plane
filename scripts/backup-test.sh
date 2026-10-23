#!/usr/bin/env bash
# Round trip on a scratch Postgres: dump the migrated test database, encrypt,
# decrypt, restore into a fresh database and compare row counts. Run the SQL
# tests first (tests/sql/run.sh) so control_plane_test exists, then:
#   PSQL="psql -h /tmp -p 5544 -U postgres" PGHOST=/tmp PGPORT=5544 PGUSER=postgres \
#     bash scripts/backup-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL="${PSQL:-psql}"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
age-keygen -o "$work/key.txt" 2>"$work/pub.txt"
pub="$(grep -o 'age1[a-z0-9]*' "$work/pub.txt" | head -1)"

# Some rows to carry through.
$PSQL -q -d control_plane_test -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into dashboard_users (id, email, role) values ('00000000-0000-0000-0000-0000000000a1','owner@example.com','owner') on conflict do nothing;
insert into schools (slug, name) values ('backup-test','Backup Test') on conflict do nothing;
SQL

DATABASE_URL="postgresql:///control_plane_test" AGE_RECIPIENT="$pub" \
  BACKUP_DRY_RUN=1 BACKUP_OUT_DIR="$work/out" bash scripts/backup.sh
enc="$(ls "$work"/out/*.dump.age)"
[ ! -e "${enc%.age}" ] || { echo "FAILED: plaintext dump left behind" >&2; exit 1; }
if age -d -i <(age-keygen 2>/dev/null) "$enc" >/dev/null 2>&1; then echo "FAILED: decrypted with the wrong key" >&2; exit 1; fi
age -d -i "$work/key.txt" -o "$work/restored.dump" "$enc"

$PSQL -q -d postgres -c "drop database if exists control_plane_restore" -c "create database control_plane_restore"
pg_restore --clean --if-exists --no-owner --dbname=control_plane_restore "$work/restored.dump"
for t in public.dashboard_users public.audit_log public.schools auth.users; do
  a="$($PSQL -At -d control_plane_test -c "select count(*) from $t")"
  b="$($PSQL -At -d control_plane_restore -c "select count(*) from $t")"
  [ "$a" = "$b" ] || { echo "FAILED: $t has $a rows, restore has $b" >&2; exit 1; }
  echo "ok $t: $a rows"
done
$PSQL -q -d postgres -c "drop database control_plane_restore"
echo "BACKUP ROUND TRIP PASSED"
