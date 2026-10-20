# amazeDB: A Supabase-like Platform

## Goal

Build a resume project resembling Supabase: a bundle of tools around PostgreSQL.
A small version where each piece actually works is more impressive than a wide
one that is half-built. Complete the core MVP first, then add supporting features.

## Tier 1: Core MVP

### 1. Project Management

- [x] Sign up and log in to the platform dashboard.
- [x] Create, list, and delete projects.
- [x] Give each project an isolated PostgreSQL schema and database role.
- [x] Generate an anon key and a service-role key per project; display once and store hashes.
- [x] Activate each project's API URL with its project ID and API key.

### 2. Database per Project

- [x] Provision a separate PostgreSQL schema in a shared instance per project.
      Dedicated databases or containers remain a possible later alternative.
- [x] Build a table editor that supports creating tables, adding columns, and
      inserting, editing, and deleting rows.
- [x] Build a basic SQL editor to run queries and display results.

### 3. Auto-generated REST API

- [x] Expose CRUD endpoints for every table, such as
      `GET /rest/v1/users?age=gt.18`.
- [x] Support filtering, sorting, pagination, and selecting specific columns.
- [x] Build a custom introspection-based REST generator. PostgREST remains an alternative, not a dependency.

### 4. Authentication

- [ ] Support email and password signup and login for project applications.
- [ ] Issue and verify JWTs.
- [ ] Implement password hashing and refresh tokens.
- [ ] Maintain a `users` table per project.
- [ ] Expose client SDK methods such as `signUp()`, `signIn()`, and `signOut()`.

### 5. Row Level Security (RLS)

- [ ] Let users write policies such as "users can only read their own rows."
- [ ] Pass JWT claims into PostgreSQL so policies work.

### 6. API Keys and Access Control

- [x] Distinguish anon keys from service-role keys with separate PostgreSQL roles.
- [x] Validate keys at the REST gateway before requests reach the database.

## Tier 2: Strong Additions

### 7. File Storage

- [ ] Create buckets, then upload, download, and delete files.
- [ ] Support public and private buckets with signed URLs.
- [ ] Back storage with local disk or MinIO, which is S3-compatible.

### 8. Realtime

- [ ] Subscribe to table changes (`INSERT`, `UPDATE`, and `DELETE`) over WebSockets.
- [ ] Use PostgreSQL `LISTEN/NOTIFY` or logical replication.
- [ ] Include a working realtime demo.

### 9. Client SDK

- [ ] Build a small JavaScript/TypeScript library.
- [ ] Support initialization with `createClient(url, key)`.
- [ ] Support fluent queries such as `.from('todos').select()`.
- [ ] Include the authentication methods from the core MVP.

### 10. Dashboard Polish

- [ ] Display usage stats: requests, database size, and storage used.
- [ ] Build an API request logs viewer.
- [ ] Display project auth users with the ability to view and delete users.

## Tier 3: Stretch Goals

- [ ] **OAuth providers:** Google and GitHub login.
- [ ] **Edge/serverless functions:** Run user-submitted JavaScript in a sandbox.
- [ ] **Database migrations:** Track migrations with version history.
- [ ] **Rate limiting:** Enforce limits per project.
- [ ] **Backups and restore:** Back up and restore project databases.
- [ ] **Team collaboration:** Invite members to a project.
- [ ] **Vector search:** Support pgvector.
- [ ] **Auto-generated API docs:** Generate OpenAPI/Swagger documentation per project.
- [ ] **Self-hosting:** Run the platform through a single Docker Compose file.

## Suggested Architecture

These are options, not finalized stack decisions.

| Layer | Options |
| --- | --- |
| Dashboard frontend | Next.js or React + Tailwind |
| Control plane API | Node.js (NestJS/Express), Go, or FastAPI |
| Per-project database | PostgreSQL Docker containers or separate schemas |
| API gateway | Kong, Nginx, or a custom Go/Node.js proxy |
| REST layer | Custom introspection-based generator (implemented); PostgREST remains an alternative |
| Auth service | Custom JWT authentication or GoTrue |
| Storage | Local disk or MinIO |
| Realtime | Node.js/Elixir WebSocket server using PostgreSQL notifications or logical replication |
| Orchestration | Docker and Docker Compose |

## Suggested Build Order

| Timeline | Focus | Deliverables |
| --- | --- | --- |
| Weeks 1-2 | Control plane and provisioning | Dashboard signup/login; create, list, and delete projects; provision a PostgreSQL schema or container per project. |
| Week 3 | Database tools | Table editor and SQL editor. |
| Week 4 | REST API and gateway | Implemented custom REST gateway with project API keys. |
| Week 5 | Authentication and RLS | Auth service, JWTs, password hashing, refresh tokens, and RLS integration. |
| Week 6 | Storage | Buckets, file operations, public/private access, and signed URLs. |
| Week 7 | Realtime | WebSocket subscriptions to table changes. |
| Week 8 | SDK, docs, and demo | Client SDK, documentation, and a todo or chat application built on the platform. |

Dashboard polish has no dedicated week in the initial schedule. Tier 3 remains
optional and outside the initial eight-week build order.

## Selected Foundation

- Budget: $0 infrastructure cost while developing and demonstrating locally.
- Dashboard and control plane: Next.js App Router, React, and TypeScript in `apps/web`.
- Database: PostgreSQL, with project-specific schemas and NOLOGIN roles.
- Dashboard authentication: scrypt passwords and revocable HttpOnly cookie sessions.
      This is not the per-project application auth service planned for week 5.
- REST layer: custom introspection-based PostgreSQL gateway with anon/service keys.
- Runtime: native Node.js plus local PostgreSQL, or Docker Compose for the current foundation.
- Deployment: no paid host or domain for now; GitHub source, documentation, and a recorded demo.
- Remaining service choices stay open until their milestones.

## Current Status

The first control-plane milestone is implemented: account access, owner-scoped
project management, transactional schema/role provisioning, and one-time API
key issuance. Passwords, keys, and sessions are stored as hashes. Isolation and
ownership are tested against real PostgreSQL. Desktop and mobile browser flows,
lint, type checking, and the production build pass.

Compose syntax is validated; container execution is pending because the local
Docker engine is stopped. The native PostgreSQL workflow is verified. The full
dependency audit has a documented development-only ESLint dependency advisory;
the production dependency audit is clear.

The database-tools milestone is also implemented: table introspection, table and
column creation, typed row insertion/editing/deletion, 50-row pagination, and a
basic SQL editor. Row edits/deletes require a primary key. SQL is parsed with
PostgreSQL's parser, runs one statement at a time, times out after five seconds,
and returns at most 200 rows with a 2 MB result limit.

Each project's schema owner remains NOLOGIN. Database tools lazily provision a
separate restricted login that can assume only that project's owner role.
Untrusted SQL never uses the administrative connection; role-reset and
cross-project access attempts are covered by PostgreSQL integration tests.
Desktop and mobile browser tests cover both project management and database
tools. The standalone production server also passed SQL parser execution and
row-insertion smoke checks; Docker container execution is still unverified.

The REST/API-key milestone is implemented at `/api/rest/v1/:projectId/:table`.
It supports GET/POST/PATCH/DELETE, selected columns, typed filters (`eq`, `neq`,
`gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`), ordering, and bounded
pagination. API keys are checked by hash. Anon and service keys use distinct,
restricted per-project PostgreSQL roles. Requests without a key, invalid keys,
cross-project keys, and mutations without filters are rejected. CORS is enabled
for browser clients.

The public anon role currently has CRUD access to every table. RLS and per-project
application auth are not implemented; never use sensitive data or expose this
local MVP as a hosted service yet. GET results are capped at 1000 rows / 2 MB,
request bodies at 64 KB / 100 rows, and filtered PATCH/DELETE at 100 matched rows
or 1 MB of matched data, with rollback above either limit. PostgreSQL integration tests cover role
permissions and rollback; browser tests exercise key-authenticated CRUD.

Next: per-project application authentication and RLS. Storage, realtime, the SDK,
rate limits, and public hosting remain pending. The anon key currently has CRUD
access to all project tables; do not use sensitive data before RLS exists. The
Markdown roadmap is the source of truth; the earlier SQLite planning artifact is
not updated.