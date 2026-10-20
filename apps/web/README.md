# amazeDB Dashboard and Control Plane

This Next.js app contains the dashboard, control-plane HTTP routes, PostgreSQL
provisioning service, and tests. See the [root README](../../README.md) for local
setup, Docker Compose, security boundaries, and the current implementation scope.

With `.env.local` configured and dependencies installed:

```sh
npm run db:migrate
npm run dev -- --hostname 127.0.0.1
```

Open http://localhost:3000.
