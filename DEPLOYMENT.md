# Production backend deployment

The portal is served by FastAPI and stores accounts, applications, sessions,
portal operations data, and transaction records in PostgreSQL. Transaction
records are not payment processing; no payment gateway is configured.

## Railway

1. Create a Railway project, add a PostgreSQL database, and deploy this
   repository as a web service. `railway.toml` supplies the Uvicorn start
   command and `/api/health` readiness check.
2. In the web service's **Settings → Volumes**, add a persistent volume
   mounted at `/data`. Keep the service at one replica when using a Railway
   volume; Railway volumes are not shared between replicas. Use private object
   storage instead if the service needs multiple replicas.
3. In the web service's **Variables** page, add the following (never commit
   secrets):
   - `DATABASE_URL`: Railway reference to the PostgreSQL service's
     `DATABASE_URL` (for example `${{Postgres.DATABASE_URL}}`; use the actual
     database service name).
   - `APP_ENV`: `production`.
   - `MASTER_ADMIN_MOBILE`: the Master Admin's verified 10–15 digit mobile.
   - `RM_MASTER_BOOTSTRAP_TOKEN`: a newly generated, one-time random secret
     of at least 32 characters.
   - `UPLOAD_STORAGE_DIR`: `/data/private-documents`.
   - `DOCUMENT_ENCRYPTION_KEY`: generate a fresh Fernet key using
     `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
     and save the output as a Railway secret. Keep a protected backup of this
     key; losing it makes stored documents unrecoverable. Do not rotate it
     without first re-encrypting stored documents.
   - Optional PostgreSQL pool tuning: `DB_POOL_SIZE` (default `5`),
     `DB_MAX_OVERFLOW` (default `5`), `DB_POOL_TIMEOUT_SECONDS` (default
     `30`), and `DB_POOL_RECYCLE_SECONDS` (default `1800`). The maximum
     connections per server process are pool size plus overflow; keep this
     total multiplied by the number of server processes within the PostgreSQL
     connection limit.
4. The server checks that the upload directory is inside a mounted volume on
   Railway, creates it with private directory permissions, and stores files
   with random names and restrictive permissions. Missing volume configuration
   prevents startup rather than silently writing customer files to ephemeral
   deployment storage.
5. Wait for `/api/health` to report `{"status":"ok","database":"connected"}`.
   Tables are created during startup. This does not migrate an existing
   schema; apply a reviewed database migration before deploying future model
   changes. The PostgreSQL engine uses `pool_pre_ping`, a 30-second pool
   timeout, a 30-minute connection recycle, and a default pool limit of five
   connections plus five overflow connections per process. The SQLite
   fallback is for local development only.
6. Open `/login.html`, select the configured Master Admin mobile, and complete
   first-time setup with the bootstrap token, a strong password, and a private
   recovery phrase. Remove `RM_MASTER_BOOTSTRAP_TOKEN` from the Railway service
   after setup; the token cannot reset an already configured Master Admin.
7. Verify login, partner applications, document uploads/downloads as Master
   Admin, and role-denied document access over the deployed HTTPS domain. Do
   not use `file://` URLs or the Python static HTTP server: browser API calls
   must use the same-origin FastAPI server.

## Local development

Install `requirements.txt`, then start the local portal with:

```powershell
python start_local.py
```

The script binds to `127.0.0.1:8766` and keeps the SQLite database, encrypted
documents, one-time Master Admin setup token, and encryption key under the
current Windows user's `%LOCALAPPDATA%\RMDigitalCentre` directory, outside the
OneDrive-synced repository. It restricts that directory to the current user.
Keep the generated `portal.env` file: losing the encryption key makes stored
documents unrecoverable. Retrieve the one-time setup token from that local
file when completing first-time Master Admin setup. This local SQLite setup is
for development only; never use it for a multi-instance or production
deployment.

## Data and security notes

- Passwords and recovery phrases are hashed server-side with scrypt. Session
  credentials are random, stored hashed in the database, and delivered using
  HttpOnly cookies. HTTPS deployments use Secure cookies.
- Newly approved partner, Sub-Admin, and pre-created Retail ID accounts require
  a one-time setup code. The Master Admin dashboard displays the code; deliver
  it only through a separately verified channel. No SMS or email delivery
  provider is configured.
- The PostgreSQL database is not seeded with browser-local records. Existing
  localStorage data is intentionally not imported.
- Application and transaction documents are encrypted before they are stored
  outside the public web root on the private upload volume; PostgreSQL holds
  metadata and references only. Transaction creation accepts the existing JSON
  payload or multipart form data with repeated `files` fields. Access/download
  endpoints and the combined Master Admin document review require a Master
  Admin session.
  Uploads accept PDF, JPG, JPEG, or PNG files up to 10 MB each and 40 MB per
  application. The encryption key is independent of the database and volume;
  back it up securely and do not include it in database backups or source
  control.
  Configure access-controlled backups, a reviewed retention/deletion policy,
  and private object storage before scaling beyond one service replica.
- The transaction API stores operational records only and never transfers
  funds. A certified provider integration and reconciliation process are
  separate work.
- Configure Railway backups, retention, alerting, access controls, and
  database restore drills before real customer data is entered. Review legal,
  KYC, privacy, and payment-provider obligations for the operating region.
