# amazeDB

A local-first, Supabase-inspired backend platform built as a resume project.
The control plane and database tools work locally; this is not the complete Supabase feature set.

## Implemented

- Dashboard account signup, login, and logout.
- Scrypt password hashing and seven-day, revocable, opaque sessions.
- HttpOnly, SameSite cookies and origin checks on state-changing requests.
- Create, list, search, inspect, and delete owner-scoped projects.
- Transactional provisioning of a PostgreSQL schema and NOLOGIN role per project.
- Project roles cannot access other project schemas, control-plane tables, or the shared public schema.
- Random anon and service-role keys, displayed once and stored only as SHA-256 hashes.
- Responsive dashboard, real schema table counts, and typed-name deletion confirmation.
- Project table navigation, table/column creation, typed row CRUD, and 50-row pagination.
- Basic SQL editor with PostgreSQL parsing, query results, and actionable errors.
- Per-project restricted database connections, five-second statement timeouts,
  200-row SQL result limits, and a 2 MB SQL response-size limit.

The anon key authenticates the REST API and has CRUD grants on project tables.
Tables with RLS and an owner policy restrict access to matching users; tables
without policies remain broadly accessible. Do not store sensitive data or expose
this development service publicly. The service-role key is secret and must never
be embedded in a client application or exposed publicly. Dashboard accounts are
separate from per-project application users. Database tools and REST requests use
dedicated project logins, not administrative query connections.

## Auto-generated REST API

The custom introspection-based gateway is available at
`/api/rest/v1/:projectId/:table`. Pass the anon or service key using `apikey`
or `Authorization: Bearer <key>`:

```sh
curl 'http://localhost:3000/api/rest/v1/PROJECT_ID/todos?select=id,title&done=is.true&order=id.desc&limit=25' \
    -H 'apikey: PROJECT_ANON_KEY'
```

GET returns a JSON array. POST accepts a JSON object or up to 100 objects and
returns created rows. PATCH accepts a JSON object; PATCH and DELETE require at
least one filter. Responses include `Content-Range`; `OPTIONS` supports browser
CORS preflight. Supported filters: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`,
`ilike`, `is`, and `in`. Selection and ordering only accept real table columns;
values are parameterized. Page size is 1-1000 (default 100); request bodies are
limited to 64 KB / 100 rows. Filtered PATCH/DELETE preflight and lock matching
rows, then reject and roll back when they match over 100 rows or exceed 1 MB.
GET page size is checked before fetching rows; all responses are limited to 2 MB.

Every key is compared by its SHA-256 hash. Each key creates a distinct project
login on first use. The anon login can perform CRUD on project tables and use
sequences, but cannot create tables, access the control plane, or connect to
another project's schema. The service login can assume only its own project's
schema-owner role. Both use short-lived restricted PostgreSQL connections for
each request.

## Project Authentication and RLS

Project auth is separate from dashboard login. Use the anon key with
`/api/auth/v1/:projectId/signup`, `/login`, `/refresh`, and `/logout`. Signup and
login take `{ "email": "...", "password": "..." }`; passwords require 10-128
characters and are scrypt-hashed. Successful responses include a 15-minute
HS256 access JWT and a 30-day opaque refresh token. Refresh tokens are stored as
SHA-256 hashes, revoked on rotation/logout, and accepted once. Include the access
token as `Authorization: Bearer <access_token>` alongside `apikey: <anon_key>` on
REST calls. JWTs are bound to the project audience; verified subject and role
claims are set transaction-locally in PostgreSQL. Do not combine a user token
with the service-role key.

In a project's **RLS policies** tab, select a UUID owner column, a policy name,
and a command. Creating the policy enables RLS and adds an owner predicate using
the verified JWT subject. INSERT checks the new row; SELECT, UPDATE, and DELETE
filter by owner. The SQL editor can create policies for advanced use. Service-role
requests bypass RLS as the project schema owner. Anon requests have no user subject
and see no rows on a protected table. A table with RLS enabled and no matching
policy denies anon/authenticated access. RLS is per table: tables without policies
remain accessible to anon-key CRUD. Email verification, password recovery, and
public-service hardening are not implemented.

## TypeScript Client

Import `createClient` from `src/lib/client.ts`. The client keeps access and refresh
tokens in memory only; reloading the page signs the client out. Call
`auth.refreshSession()` explicitly when needed.

```ts
import { createClient } from "./src/lib/client";

const client = createClient(
    "http://localhost:3000/api/rest/v1/PROJECT_ID",
    "PROJECT_ANON_KEY",
);
await client.auth.signIn({ email: "alice@example.com", password: "..." });
const todos = await client
    .from("todos")
    .select("id,title")
    .eq("done", false)
    .order("id", { ascending: false })
    .limit(25)
    .execute();
```

The client also provides `auth.signUp`, `auth.signOut`, `auth.refreshSession`,
`auth.getSession`, and table `insert`, `update`, `delete`, filter, and range
methods. It sends the anon key for project access and adds the in-memory bearer
JWT after sign-in.

## Database Tools

Open a project from the dashboard, then choose **Table editor**. Create a table
with an automatically generated bigint identity primary key and optional typed
columns. Add columns, insert rows, and edit or delete individual rows. Row forms
distinguish values, SQL NULL, and omitted/default values; boolean and JSONB fields
use typed controls. Editing saves only changed fields. SQL-created tables without
primary keys are viewable and insertable, but row edits/deletes are disabled.

Use the **SQL editor** tab for one statement at a time. SELECT, INSERT, UPDATE,
DELETE, CREATE/ALTER TABLE, CREATE INDEX/POLICY, and DROP TABLE/INDEX/POLICY are supported.
Transactions, role/configuration changes, functions, procedural blocks, and
other statement types are deliberately excluded. Changes execute immediately
inside a server-managed transaction and commit only on success. SQL errors or
oversized results roll the statement back. A truncated RETURNING result does
not truncate the underlying mutation: all matching rows can still change.

Each project retains its NOLOGIN schema owner. On first database-tool use, the
control plane creates a separate NOINHERIT database login that belongs only to
that owner role. A fresh restricted connection assumes the owner role, sets the
project search path, runs the operation, and closes. Even RESET ROLE cannot regain
administrative privileges. Credentials stay server-side. Existing projects gain
their editor login automatically; no data migration is required for this milestone.

The SQL limits are development guardrails, not a complete resource sandbox.
Large intermediate database operations and individual values can consume memory
before response-size checks; keep the platform local until stronger quotas exist.

## Stack

Next.js App Router, React, TypeScript, PostgreSQL, node-postgres, Zod,
`pgsql-parser`, and Lucide. Manrope and IBM Plex Mono are bundled locally. No hosted services,
domain, or paid subscription is required.

## Run Locally

Use Node.js 22.9+ and npm. Open http://localhost:3000 and create your own account.
No demo password or seeded account is shipped.

### Option A: Docker Compose

Start Docker Desktop, then run these commands from the repository root:

```sh
cp .env.example .env
```

Set `POSTGRES_PASSWORD` in the root `.env` to a unique local password. Use
URL-safe characters, such as a random hexadecimal string, because Compose
includes the password in `DATABASE_URL`.

```sh
docker compose up -d --build
```

Compose starts the dashboard/API and PostgreSQL 17, initializes control-plane
tables on the first database boot, and persists database data in a named volume.
The dashboard binds to loopback port 3000; PostgreSQL binds to loopback port
54322 so an existing local PostgreSQL installation on 5432 does not conflict.

`docker compose down` stops the services without deleting the database volume.
Do not add `--volumes` unless you intend to erase the database. Stop any native
dashboard server using port 3000 before starting the Compose dashboard.

For later schema changes, run `npm run db:migrate` from the web app with its
`DATABASE_URL` configured for port 54322. First-boot SQL does not rerun on an
existing database volume. The Docker image/containers have not been executed
on the current machine because its Docker engine is stopped; Compose syntax
and the standalone application build have been validated.

### Option B: Native PostgreSQL and Hot Reload

Use a dedicated PostgreSQL 14+ database. Never point the migration at an existing
application database: it changes the dedicated database's public schema grants.
The provisioning connection needs permission to create/drop schemas and roles;
the Docker setup uses an administrative account for this local-only control plane.

```sh
createdb amazedb_dev
cd apps/web
npm ci
cp .env.example .env.local
```

Set `DATABASE_URL` in `.env.local` to your dedicated database connection string.
For a local installation with trust authentication, this may be
`postgresql://YOUR_OS_USERNAME@127.0.0.1:5432/amazedb_dev`. Include a password
if your installation requires one. Keep `APP_ORIGIN=http://localhost:3000`.

```sh
npm run db:migrate
npm run dev -- --hostname 127.0.0.1
```

This working checkout is already configured with an ignored `.env.local` for
the dedicated `amazedb_dev` database on the existing local PostgreSQL server.

All modifying API requests must send an `Origin` header matching `APP_ORIGIN`.
When `APP_ORIGIN` uses a loopback hostname, `localhost`, `127.0.0.1`, and `[::1]`
are also accepted on the same protocol and port. Non-loopback deployments require
an exact origin match. The browser sends this header automatically. When changing
the port or enabling HTTPS, update `APP_ORIGIN`. Cookies use Secure when that
origin uses HTTPS.

## Verification

From `apps/web`, with the dedicated database configured and migrated:

```sh
npm test
npm run lint
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

The PostgreSQL integration tests cover dashboard and project-user password/key
hashing, duplicate signup, failed login, refresh rotation/replay/revocation, JWT
expiry/audience validation, two-user RLS isolation, owner scoping, schema isolation,
public-schema restrictions, editor-login role-reset attacks, and schema/role
deletion. They also cover table/column creation, keyed row CRUD, SQL parsing,
timeouts, result limits, pagination, injection attempts, and complete writes
with truncated RETURNING results. SDK tests cover fluent queries and in-memory
auth. Browser tests cover the account/project lifecycle, database tools, app auth,
and RLS on desktop and mobile. They check copying, search, reload persistence,
origin checks, invalid/oversized JSON, typed editing, SQL errors, no-primary-key
tables, and pagination. Tests create their own accounts and
clean up their own data. Browser tests start a development server if needed and
write screenshots under the ignored `apps/web/test-results` directory.

The production dependency audit reports no advisories at implementation time.
The full audit reports five high-severity entries through one development-only
`braces`/ESLint dependency chain. npm offers no non-breaking fix; do not apply
`npm audit fix --force`, which proposes downgrading the Next.js ESLint config.

## Control-plane API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/control/health` | Database connectivity |
| POST | `/api/control/auth/signup` | Create a dashboard account and session |
| POST | `/api/control/auth/login` | Start a dashboard session |
| GET | `/api/control/auth/session` | Read the current dashboard account |
| POST | `/api/control/auth/logout` | Revoke the current session |
| POST | `/api/auth/v1/:projectId/signup` | Create a project user and issue access/refresh tokens |
| POST | `/api/auth/v1/:projectId/login` | Authenticate a project user |
| POST | `/api/auth/v1/:projectId/refresh` | Rotate a project refresh token |
| POST | `/api/auth/v1/:projectId/logout` | Revoke a project refresh token |
| TypeScript | `createClient(url, anonKey)` | In-memory auth and fluent REST client |
| GET | `/api/control/projects` | List the signed-in account's projects |
| POST | `/api/control/projects` | Provision a project; return keys once |
| DELETE | `/api/control/projects/:id` | Delete an owned project and its schema/role |
| GET/POST/PATCH/DELETE | `/api/rest/v1/:projectId/:table` | Key-authenticated table REST API |
| OPTIONS | `/api/rest/v1/:projectId/:table` | CORS preflight |
| GET | `/api/control/projects/:id/tables` | List project tables |
| POST | `/api/control/projects/:id/tables` | Create a table with an identity primary key |
| POST | `/api/control/projects/:id/tables/:table/columns` | Add a typed column |
| GET | `/api/control/projects/:id/policies/:table` | List row-level security policies |
| POST | `/api/control/projects/:id/policies/:table` | Enable RLS and create a UUID owner policy |
| DELETE | `/api/control/projects/:id/policies/:table/:policy` | Delete a policy (RLS remains enabled) |
| GET | `/api/control/projects/:id/tables/:table/rows?page=0` | Read a 50-row page |
| POST | `/api/control/projects/:id/tables/:table/rows` | Insert `{ "values": { ... } }` |
| PATCH | `/api/control/projects/:id/tables/:table/rows` | Update `{ "key": { ... }, "values": { ... } }` |
| DELETE | `/api/control/projects/:id/tables/:table/rows` | Delete using `{ "key": { ... } }` |
| POST | `/api/control/projects/:id/sql` | Execute `{ "sql": "..." }` under the project role |

## Scope and Next Steps

This is a localhost development system, not a hardened public hosting platform.
Do not expose it to the internet yet. Public deployment needs authentication
rate limits, email verification/recovery, request quotas, backups, TLS, secret
management, and a narrower provisioning privilege boundary. Database statement
timeouts and UI confirmation are not substitutes for those controls.

Next: local file storage. Tables without RLS policies still allow anon-key CRUD,
so keep this local and avoid sensitive data. See [plan.md](plan.md) for the full roadmap.