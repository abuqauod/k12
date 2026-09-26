#!/bin/sh
# SAMS 8.5 — one backup of the whole database: a gzipped mongodump archive
# named by UTC time, older archives beyond BACKUP_KEEP_DAYS removed, and an
# optional copy to S3-compatible storage.
#
# Runs inside the `backup` service of docker-compose.yml (daily), or by hand:
#   docker compose run --rm backup /scripts/backup.sh
#
# Environment:
#   BACKUP_URI          mongodb://… with credentials (the service sets it)
#   BACKUP_DIR          where archives go (default /backups)
#   BACKUP_KEEP_DAYS    local retention (default 14)
#   BACKUP_S3_BUCKET    optional, e.g. s3://my-school-backups/sams
#   BACKUP_S3_ENDPOINT  optional, for non-AWS storage (R2, Wasabi, MinIO…)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION for S3
set -eu

dir="${BACKUP_DIR:-/backups}"
keep="${BACKUP_KEEP_DAYS:-14}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$dir/sams-$stamp.archive.gz"

mkdir -p "$dir"
# Written under a temporary name first, so a half-written archive is never
# mistaken for a good one by the restore script or the retention sweep.
mongodump --uri="$BACKUP_URI" --archive="$file.part" --gzip --quiet
mv "$file.part" "$file"
echo "backup written: $file ($(du -h "$file" | cut -f1))"

find "$dir" -name 'sams-*.archive.gz' -mtime +"$keep" -print -delete
find "$dir" -name 'sams-*.part' -mmin +600 -delete

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "BACKUP_S3_BUCKET is set but the aws CLI is not installed in this image" >&2
    exit 1
  fi
  endpoint=""
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && endpoint="--endpoint-url $BACKUP_S3_ENDPOINT"
  # shellcheck disable=SC2086
  aws s3 cp $endpoint --only-show-errors "$file" "${BACKUP_S3_BUCKET%/}/$(basename "$file")"
  echo "copied to ${BACKUP_S3_BUCKET%/}/$(basename "$file")"
fi
