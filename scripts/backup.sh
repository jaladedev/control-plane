#!/usr/bin/env bash
# Backs up the control plane's own database: pg_dump (schemas public and auth,
# so dashboard logins and their 2FA factors come back too), checks the dump is
# readable, encrypts it with age, uploads it to R2 and prunes old copies.
#
# Environment:
#   DATABASE_URL     connection string for the control-plane project. From GitHub
#                    Actions use the SESSION POOLER string (IPv4); the direct
#                    db.<ref>.supabase.co host is IPv6-only.
#   AGE_RECIPIENT    age PUBLIC key (age1...). The private key is kept offline,
#                    never in GitHub or the app.
#   R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#                    (not needed when BACKUP_DRY_RUN=1)
#   BACKUP_PREFIX    key prefix in the bucket (default: control-plane)
#   BACKUP_KEEP      how many of the newest backups to keep (default: 30)
#   BACKUP_DRY_RUN   1 = dump and encrypt only; leave the file in BACKUP_OUT_DIR
#   BACKUP_OUT_DIR   working directory (default: ./backup-out)
#
# Needs pg_dump and pg_restore (client version >= the server's), age, and for
# uploads the aws CLI. Never prints DATABASE_URL or any key.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL}"
: "${AGE_RECIPIENT:?Set AGE_RECIPIENT (an age public key)}"
case "$AGE_RECIPIENT" in age1*) ;; *) echo "AGE_RECIPIENT must be an age public key (age1...)." >&2; exit 1 ;; esac

PREFIX="${BACKUP_PREFIX:-control-plane}"
KEEP="${BACKUP_KEEP:-30}"
DRY="${BACKUP_DRY_RUN:-0}"
OUT="${BACKUP_OUT_DIR:-./backup-out}"
case "$KEEP" in ''|*[!0-9]*) echo "BACKUP_KEEP must be a number." >&2; exit 1 ;; esac
[ "$KEEP" -ge 7 ] || { echo "BACKUP_KEEP must be at least 7." >&2; exit 1; }

if [ "$DRY" != "1" ]; then
  : "${R2_ENDPOINT:?Set R2_ENDPOINT}" "${R2_BUCKET:?Set R2_BUCKET}"
  : "${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID}" "${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY}"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
dump="$OUT/$stamp.dump"
enc="$dump.age"
trap 'rm -f "$dump"' EXIT   # the unencrypted dump never outlives the script

echo "Dumping..."
pg_dump --format=custom --no-owner --no-privileges \
  --schema=public --schema=auth --file="$dump" --dbname="$DATABASE_URL"

# A dump that cannot be listed, or that is missing the tables that matter, is
# a failed backup even though pg_dump exited 0.
listing="$(pg_restore --list "$dump")"
for t in dashboard_users audit_log schools; do
  echo "$listing" | grep -q "TABLE DATA public $t " || { echo "Dump has no data section for public.$t." >&2; exit 1; }
done
echo "$listing" | grep -q "TABLE DATA auth users " || { echo "Dump has no data section for auth.users." >&2; exit 1; }

age -r "$AGE_RECIPIENT" -o "$enc" "$dump"
size="$(wc -c < "$enc" | tr -d ' ')"
[ "$size" -gt 1024 ] || { echo "Encrypted backup is suspiciously small ($size bytes)." >&2; exit 1; }
echo "Encrypted backup: $enc ($size bytes)"

if [ "$DRY" = "1" ]; then
  echo "Dry run: not uploading."
  exit 0
fi

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto
key="$PREFIX/$stamp.dump.age"
aws s3 cp --only-show-errors --endpoint-url "$R2_ENDPOINT" "$enc" "s3://$R2_BUCKET/$key"
echo "Uploaded $key"

# Prune: only keys that look exactly like our own backups, oldest first, and
# never the newest $KEEP.
keys="$(aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" \
  --prefix "$PREFIX/" --query 'Contents[].Key' --output text | tr '\t' '\n' | sort)"
mine="$(echo "$keys" | grep -E "^$PREFIX/[0-9]{8}T[0-9]{6}Z\.dump\.age$" || true)"
count="$(echo "$mine" | grep -c . || true)"
if [ "$count" -gt "$KEEP" ]; then
  echo "$mine" | head -n "$((count - KEEP))" | while read -r old; do
    aws s3 rm --only-show-errors --endpoint-url "$R2_ENDPOINT" "s3://$R2_BUCKET/$old"
    echo "Pruned $old"
  done
fi
echo "Done. $count backup(s) before pruning."
