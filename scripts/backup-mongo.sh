#!/usr/bin/env bash
# =====================================================
# Encrypted, access-controlled MongoDB backup
# =====================================================
# Dumps the database, compresses it, encrypts the archive at rest with a
# symmetric key, and (optionally) ships it to an off-box object store. Designed
# to run from cron on the droplet, e.g. nightly:
#
#   0 3 * * *  /var/www/quickqare-backend/scripts/backup-mongo.sh >> /var/log/qq-backup.log 2>&1
#
# Required env (set in a root-only file, e.g. /etc/quickqare-backup.env, and
# `source` it from the cron entry — NEVER commit real values):
#   MONGO_URI            same connection string the app uses
#   BACKUP_ENCRYPTION_KEY passphrase used to encrypt the archive (openssl aes-256)
# Optional:
#   BACKUP_DIR           local staging dir           (default: /var/backups/quickqare)
#   BACKUP_RETENTION_DAYS delete local dumps older than N days (default: 14)
#   R2_BACKUP_BUCKET / R2_ENDPOINT  push to S3-compatible storage if set
#                        (uses the AWS CLI; credentials via env or ~/.aws)
#
# Restore (manual, deliberately not automated):
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY \
#     -in qq-YYYYMMDD.archive.gz.enc | gunzip | mongorestore --archive --drop --uri "$MONGO_URI"

set -euo pipefail

: "${MONGO_URI:?MONGO_URI is required}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required (backups must be encrypted at rest)}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/quickqare}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/qq-${STAMP}.archive.gz.enc"

mkdir -p "$BACKUP_DIR"
# Lock down the staging dir so other local users can't read dumps.
chmod 700 "$BACKUP_DIR"

echo "[backup] $(date -Is) starting dump → ${OUT}"

# Dump → gzip → AES-256 encrypt, all streamed (no plaintext archive ever lands
# on disk). mongodump --archive writes a single stream to stdout.
mongodump --uri "$MONGO_URI" --archive --gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_ENCRYPTION_KEY \
  > "$OUT"

chmod 600 "$OUT"
echo "[backup] wrote encrypted archive ($(du -h "$OUT" | cut -f1))"

# Off-box copy (optional). Object-store bucket MUST be private with its own
# access controls — this is your disaster-recovery copy.
if [[ -n "${R2_BACKUP_BUCKET:-}" && -n "${R2_ENDPOINT:-}" ]]; then
  echo "[backup] uploading to ${R2_BACKUP_BUCKET}"
  aws s3 cp "$OUT" "s3://${R2_BACKUP_BUCKET}/" --endpoint-url "$R2_ENDPOINT"
fi

# Retention: prune old local encrypted dumps.
find "$BACKUP_DIR" -name 'qq-*.archive.gz.enc' -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] done; pruned dumps older than ${RETENTION_DAYS}d"
