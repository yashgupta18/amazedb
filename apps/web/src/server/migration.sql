CREATE SCHEMA IF NOT EXISTS control_plane;
REVOKE ALL ON SCHEMA control_plane FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE TABLE IF NOT EXISTS control_plane.accounts (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_plane.sessions (
    token_hash text PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES control_plane.accounts(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON control_plane.sessions(account_id);

CREATE TABLE IF NOT EXISTS control_plane.projects (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES control_plane.accounts(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    schema_name text NOT NULL UNIQUE,
    anon_key_hash text NOT NULL UNIQUE,
    service_key_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON control_plane.projects(owner_id);

CREATE TABLE IF NOT EXISTS control_plane.application_users (
    id uuid NOT NULL,
    project_id uuid NOT NULL REFERENCES control_plane.projects(id) ON DELETE CASCADE,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, id),
    UNIQUE (project_id, email)
);
CREATE TABLE IF NOT EXISTS control_plane.application_refresh_tokens (
    token_hash text PRIMARY KEY,
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, user_id)
        REFERENCES control_plane.application_users(project_id, id)
        ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS application_refresh_user_idx
    ON control_plane.application_refresh_tokens(project_id, user_id);