#!/bin/sh
# SAMS 8.5 — restores one backup archive over the database.
#
#   docker compose run --rm backup /scripts/restore.sh /backups/sams-20260926T020000Z.archive.gz
#
# Every collection in the archive is dropped and replaced (--drop); the
# collections are restored as they were at backup time, so anything written
# since is lost. Stop the API first (docker compose stop api) so nothing
# writes during the restore, then start it again: its migrations re-run and
# are safe to repeat.
#
# To rehearse without touching the live data, restore into another database:
#   RESTORE_NS_TO=timetable_drill docker compose run --rm backup /scripts/restore.sh <archive>
set -eu

archive="${1:-}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "usage: restore.sh <archive.gz>   (archives in ${BACKUP_DIR:-/backups}:)" >&2
  ls -1t "${BACKUP_DIR:-/backups}"/sams-*.archive.gz 2>/dev/null | head -10 >&2 || true
  exit 2
fi

if [ -n "${RESTORE_NS_TO:-}" ]; then
  mongorestore --uri="$BACKUP_URI" --archive="$archive" --gzip --drop \
    --nsFrom='timetable.*' --nsTo="$RESTORE_NS_TO.*"
  echo "restored $archive into database $RESTORE_NS_TO"
else
  if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
    echo "This replaces the live database with $archive." >&2
    echo "Re-run with RESTORE_CONFIRM=yes to go ahead." >&2
    exit 3
  fi
  mongorestore --uri="$BACKUP_URI" --archive="$archive" --gzip --drop
  echo "restored $archive"
fi
