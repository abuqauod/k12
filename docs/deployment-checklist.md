# Deployment checklist (SAMS 8.6)

What to do, in order, to put ArrangeMySchool in front of a real school, and
what to check after every deploy. Server details are in
[`server/README.md`](../server/README.md); every setting is described in
[`server/.env.example`](../server/.env.example).

## 1. Before the first start

- [ ] A VPS with Docker (2 vCPU / 4 GB is enough for several schools), ports
      80 and 443 open, the API domain's DNS pointing at it.
- [ ] `server/.env` created from `.env.example`, with:
  - [ ] `JWT_SECRET` — `openssl rand -base64 48`. The API refuses to start
        with the default or anything under 32 characters.
  - [ ] `MONGO_ROOT_PASSWORD` — a long random value. The API refuses the
        default. Set it **before** the first `docker compose up`: MongoDB
        keeps the password it was first started with.
  - [ ] `API_DOMAIN`, `APP_URL` (the school app's https address) and
        `CORS_ORIGINS` (the same address).
  - [ ] Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
        `SMTP_FROM`. Without it no invites, password resets or family
        emails are sent.
  - [ ] SMS (optional): `SMS_PROVIDER` and its keys, and
        `SMS_DEFAULT_COUNTRY_CODE`.
  - [ ] Off-site backups: `BACKUP_S3_BUCKET` (+ `BACKUP_S3_ENDPOINT` for
        non-AWS storage) and the `AWS_*` keys. Local archives alone are lost
        with the server.
  - [ ] Error reporting (recommended): `ERROR_REPORTING_DSN` from Sentry or
        GlitchTip.
- [ ] GitHub secrets for the deploy workflow: `SSH_HOST`, `SSH_USER`,
      `SSH_PRIVATE_KEY`, and `UI_DOCROOT` (where the web server serves the
      school app from).

## 2. First start

```bash
cd ~/k12/server
docker compose up -d --build
docker compose logs api | grep preflight   # every line should read as expected
curl -fsS https://$API_DOMAIN/ready          # {"ok":true,...}
docker compose exec api node dist/createAdmin.js you@example.com 'a strong password' 'Your Name'
```

- [ ] `/ready` answers `ok`.
- [ ] The preflight lines show email (and SMS) **on**, no warnings left
      that you did not decide to accept.
- [ ] Sign in to `/console`, create the school, the owner receives the
      invite email.
- [ ] In the school app: Communication → Automatic notices → Delivery
      channels → **Send test** for email and SMS.

## 3. Backups — prove them before you need them

- [ ] The day after the first start, `ls server/backups` shows an archive
      (and the S3 bucket has its copy).
- [ ] Restore drill into a scratch database, then drop it:

```bash
docker compose run --rm -e RESTORE_NS_TO=timetable_drill backup \
  /scripts/restore.sh /backups/<newest archive>
docker compose exec db mongosh -u root -p "$MONGO_ROOT_PASSWORD" --quiet \
  --eval 'db.getSiblingDB("timetable_drill").dropDatabase()'
```

- [ ] Repeat the drill every term. A real restore (replaces live data):
      `docker compose stop api`, then the same command without
      `RESTORE_NS_TO` and with `-e RESTORE_CONFIRM=yes`, then
      `docker compose start api`.

## 4. Every deploy

The `Deploy` workflow does this on each push to `main`: tests (server and
school app) → build → copy the app → rebuild the API → wait for `/ready`.
A deploy whose API does not come up fails and prints the API's last log
lines. After it:

- [ ] `curl https://$API_DOMAIN/ready` shows the new `release`.
- [ ] Sign in; open the dashboard and one heavy page (students, finance).
- [ ] No new errors in the error-reporting service.

## 5. Watching it

- [ ] An uptime monitor (UptimeRobot, Better Stack, …) on
      `https://$API_DOMAIN/ready` every minute, alerting by email/SMS.
- [ ] Disk space alert on the VPS (backups and MongoDB grow).
- [ ] Every error response carries a `requestId`, also in the
      `x-request-id` header; search the API logs
      (`docker compose logs api | grep <id>`) or the error-reporting service
      for it when a user reports a problem.
