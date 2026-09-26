# SAMS 8.5 — the backup service: MongoDB's own tools plus the AWS CLI for
# the optional off-site copy (works with any S3-compatible storage).
FROM mongo:7
RUN apt-get update \
  && apt-get install -y --no-install-recommends awscli \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/backup.sh scripts/restore.sh /scripts/
RUN chmod +x /scripts/*.sh
