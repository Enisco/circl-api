# Circl API

Backend API for the Circl platform, built with NestJS, PostgreSQL (Prisma), and Redis (BullMQ).

---

## Prerequisites

- **Node.js** >= 24.0.0
- **pnpm** >= 10.0.0 (`corepack enable && corepack use pnpm@latest`)
- **Docker** (for local PostgreSQL and Redis)
- **pgAdmin** (optional — for database inspection)

---

## 1. Project Setup

### Clone and install

```bash
git clone <repo-url>
cd circl-api
pnpm install
```

### Set up environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in the required values (see the [Environment Variables](#environment-variables) section below).

---

## 2. Start Local Infrastructure (Docker)

The `docker-compose.yaml` spins up PostgreSQL and Redis locally.

```bash
docker compose up -d
```

This starts:
- **PostgreSQL** on port `5432` — database `circl`, user `admin`, password `testpass`
- **Redis** on port `6379`

To stop:

```bash
docker compose down
```

To stop and remove volumes (wipes all data):

```bash
docker compose down -v
```

---

## 3. Connect pgAdmin to the Local PostgreSQL

1. Open pgAdmin and click **Add New Server**.
2. On the **General** tab, set **Name** to `circl-local`.
3. On the **Connection** tab, fill in:
   - **Host**: `localhost`
   - **Port**: `5432`
   - **Maintenance database**: `circl`
   - **Username**: `admin`
   - **Password**: `testpass`
4. Click **Save**.

You should now see the `circl` database in the pgAdmin tree.

---

## 4. Run Migrations

After starting Docker, apply the database schema:

```bash
pnpm db:migrate-dev
```

This creates all tables and applies any pending migrations. For production/CI:

```bash
pnpm db:migrate-deploy
```

After any schema change (`prisma/models/*.prisma` edits), regenerate the Prisma client:

```bash
pnpm db:generate
```

---

## 5. Run Seeders

Seeders are idempotent (safe to re-run). Run them in order after the initial migration:

```bash
# 1. Seed permissions
npx ts-node -r tsconfig-paths/register prisma/seeders/permission.seeder.ts

# 2. Seed roles (references permissions)
npx ts-node -r tsconfig-paths/register prisma/seeders/role.seeder.ts
```

Or use the combined seed script:

```bash
pnpm db:seed
```

---

## 6. Start the Development Server

```bash
pnpm start:dev
```

The API is available at `http://localhost:8008`.
Swagger UI is available at `http://localhost:8008/docs` (local and development environments only).

---

## 7. Other Useful Commands

```bash
pnpm build              # Production build
pnpm typecheck          # TypeScript check without emit
pnpm lint               # ESLint
pnpm format             # Prettier write
pnpm test               # Run unit tests
pnpm test:e2e           # Run E2E tests (requires live DB)
pnpm prisma:studio      # Open Prisma Studio (visual DB browser)
```

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in all required values.

| Variable                    | Required | Description                                                    |
| --------------------------- | -------- | -------------------------------------------------------------- |
| `APP_ENV`                   | Yes      | `local`, `development`, or `production`                        |
| `APP_NAME`                  | Yes      | Application name (e.g. `circl`)                                |
| `APP_PORT`                  | Yes      | Port to listen on (default `8008`)                             |
| `DATABASE_URL`              | Yes      | PostgreSQL connection string                                    |
| `REDIS_URL`                 | Yes      | Redis connection string                                         |
| `GOOGLE_CLIENT_ID`          | Yes      | Google OAuth web client ID                                      |
| `GOOGLE_IOS_CLIENT_ID`      | Yes      | Google OAuth iOS client ID                                      |
| `GOOGLE_ANDROID_CLIENT_ID`  | Yes      | Google OAuth Android client ID                                  |
| `APPLE_BUNDLE_ID`           | Yes      | Apple bundle ID for Sign-In with Apple                          |
| `APPLE_JWKS_URI`            | Yes      | Apple JWKS endpoint (`https://appleid.apple.com/auth/keys`)     |
| `JWT_SIGNUP_SECRET`         | Yes      | Secret for signup/email-verification tokens                     |
| `JWT_SIGNUP_EXPIRY`         | No       | Signup token TTL (default `15m`)                               |
| `ADMIN_JWT_ACCESS_SECRET`   | Yes      | Admin panel access token secret                                 |
| `ADMIN_JWT_ACCESS_EXPIRY`   | No       | Admin access token TTL (default `15m`)                         |
| `ADMIN_JWT_REFRESH_SECRET`  | Yes      | Admin panel refresh token secret                                |
| `ADMIN_JWT_REFRESH_EXPIRY`  | No       | Admin refresh token TTL (default `14d`)                        |
| `FIREBASE_PROJECT_ID`       | Yes      | Firebase project ID (for FCM push notifications)               |
| `FIREBASE_CLIENT_EMAIL`     | Yes      | Firebase service account email                                  |
| `FIREBASE_PRIVATE_KEY`      | Yes      | Firebase service account private key (include `\n` line breaks) |
| `RESEND_API_KEY`            | No       | Resend API key (for transactional email)                        |
| `AWS_ACCESS_KEY_ID`         | No       | AWS access key (for S3/SES)                                     |
| `AWS_SECRET_ACCESS_KEY`     | No       | AWS secret key                                                  |
| `AWS_REGION`                | No       | AWS region (default `eu-west-2`)                               |

**Local development shortcut** — the Docker Compose file provides PostgreSQL and Redis. Your `DATABASE_URL` for local dev is:

```
postgresql://admin:testpass@localhost:5432/circl
```

---

## Project Structure

```
src/
├── common/             # Shared decorators, guards, filters, interceptors, DTOs, constants
├── config/             # App config and Joi validation schema
├── infrastructure/     # Prisma, Redis, BullMQ, Pino logger
└── modules/
    ├── core/
    │   ├── auth/       # Registration, login, social auth, email verification, sessions
    │   └── users/      # User profile, notification preferences
    └── infrastructure/
        ├── events/     # Domain event bus
        ├── notification/ # Email + push notification providers
        ├── scheduler/  # Scheduled jobs
        └── workers/    # BullMQ job processors
prisma/
├── models/             # Split schema files (merged automatically)
├── migrations/         # Generated migration SQL
└── seeders/            # Idempotent seed scripts
```
