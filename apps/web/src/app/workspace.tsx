"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Database,
  Folder,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  LogOut,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { Account, Project } from "@/server/control-plane";

type Provisioned = {
  project: Project;
  keys: { anon: string; service: string };
};

export async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/control/${path}`, {
    method,
    headers:
      method === "GET" ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Database size={21} strokeWidth={2.2} />
      </span>
      amaze<span className="brand-suffix">DB</span>
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="icon-button"
          title="Close"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function CopyValue({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(!secret);
  const [error, setError] = useState("");
  return (
    <div className="copy-field">
      <div className="field-caption">
        <label>{label}</label>
        {secret && (
          <button className="text-button" onClick={() => setVisible(!visible)}>
            {visible ? "Hide" : "Reveal"}
          </button>
        )}
      </div>
      <div className="copy-value">
        <code>{visible ? value : "*".repeat(32)}</code>
        <button
          className="icon-button"
          title={`Copy ${label}`}
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setError("");
            } catch {
              setError("Clipboard unavailable.");
            }
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

export default function Workspace() {
  const [account, setAccount] = useState<Account | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<Provisioned | null>(null);
  const [selected, setSelected] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deleteName, setDeleteName] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = await api("auth/session");
        const data = session.account ? await api("projects") : { projects: [] };
        if (active) {
          setAccount(session.account);
          setProjects(data.projects);
        }
      } catch (caught) {
        if (active) setError((caught as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const session = await api(`auth/${authMode}`, "POST", {
        email: form.get("email"),
        password: form.get("password"),
      });
      const data = await api("projects");
      setAccount(session.account);
      setProjects(data.projects);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const data: Provisioned = await api("projects", "POST", {
        name: form.get("name"),
      });
      setProjects((current) => [data.project, ...current]);
      setCreateOpen(false);
      setCreated(data);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (!deleting || deleteName !== deleting.name) return;
    setBusy(true);
    setError("");
    try {
      await api(`projects/${deleting.id}`, "DELETE");
      setProjects((current) =>
        current.filter((project) => project.id !== deleting.id),
      );
      setDeleting(null);
      setDeleteName("");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main className="loading-screen">
        <Brand />
        <LoaderCircle
          className="spin"
          size={24}
          aria-label="Loading workspace"
        />
      </main>
    );

  if (!account)
    return (
      <main className="auth-shell">
        <header className="auth-header">
          <Brand />
          <span className="environment">
            <span className="status-dot" />
            Local development
          </span>
        </header>
        <section className="auth-content">
          <div className="auth-emblem">
            <Database size={32} strokeWidth={1.4} />
          </div>
          <p className="eyebrow">YOUR WORKSPACE</p>
          <h1>
            {authMode === "signup" ? "Create your account" : "Welcome back"}
          </h1>
          <div className="segmented" aria-label="Account access">
            <button
              aria-pressed={authMode === "signup"}
              onClick={() => {
                setAuthMode("signup");
                setError("");
              }}
            >
              Create account
            </button>
            <button
              aria-pressed={authMode === "login"}
              onClick={() => {
                setAuthMode("login");
                setError("");
              }}
            >
              Sign in
            </button>
          </div>
          <form onSubmit={authenticate}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              maxLength={254}
            />
            <label htmlFor="password">
              Password <span className="muted">(10+ characters)</span>
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={
                authMode === "signup" ? "new-password" : "current-password"
              }
              required
              minLength={10}
              maxLength={128}
            />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary full-width" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <ArrowRight size={17} />
              )}
              {authMode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>
          <div className="auth-footnote">
            <ShieldCheck size={15} />
            Local workspace account
          </div>
        </section>
        <footer className="auth-footer">
          amazeDB <span>Control plane / v0.1</span>
        </footer>
      </main>
    );

  const filtered = projects.filter((project) =>
    project.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">
          <span className="workspace-avatar">P</span>
          <div>
            Personal workspace<small>Local instance</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Workspace">
          <Link className="nav-active" href="/">
            <LayoutGrid size={18} />
            Projects<span>{projects.length}</span>
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <Server size={17} />
            <div>
              Local PostgreSQL<small>Connected</small>
            </div>
            <span className="status-dot" />
          </div>
          <div className="account-row">
            <span className="account-avatar">
              {account.email[0].toUpperCase()}
            </span>
            <span title={account.email}>{account.email}</span>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("auth/logout", "POST");
                  setAccount(null);
                  setProjects([]);
                  setCreated(null);
                  setSelected(null);
                } catch (caught) {
                  setError((caught as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span>Workspace</span>
          <ChevronRight size={14} />
          <strong>Projects</strong>
          <span className="environment">
            <span className="status-dot" />
            Local development
          </span>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">PERSONAL WORKSPACE</p>
              <h1>
                Projects<span className="heading-count">{projects.length}</span>
              </h1>
            </div>
            <button
              className="primary"
              onClick={() => {
                setError("");
                setCreateOpen(true);
              }}
            >
              <Plus size={18} />
              New project
            </button>
          </div>
          <div className="workspace-summary">
            <div>
              <Folder size={17} />
              <span>
                <strong>{projects.length}</strong> projects
              </span>
            </div>
            <div>
              <Database size={17} />
              <span>
                <strong>
                  {projects.reduce(
                    (total, project) => total + project.table_count,
                    0,
                  )}
                </strong>{" "}
                tables
              </span>
            </div>
            <div>
              <ShieldCheck size={17} />
              <span>Private workspace</span>
            </div>
          </div>
          {error && !createOpen && !deleting && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="list-toolbar">
            <h2>All projects</h2>
            <div className="search-field">
              <Search size={17} />
              <input
                aria-label="Search projects"
                placeholder="Search projects..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          {filtered.length ? (
            <div className="project-grid">
              {filtered.map((project) => (
                <article className="project-card" key={project.id}>
                  <div className="project-top">
                    <span className="project-icon">
                      <Database size={23} strokeWidth={1.6} />
                    </span>
                    <span className="project-status">
                      <span className="status-dot" />
                      Ready
                    </span>
                  </div>
                  <button
                    className="project-title"
                    onClick={() => setSelected(project)}
                  >
                    {project.name}
                    <ArrowRight size={17} />
                  </button>
                  <code className="project-reference">
                    {project.id.slice(0, 8)}
                  </code>
                  <div className="project-meta">
                    <span>PostgreSQL schema</span>
                    <span>{project.table_count} tables</span>
                  </div>
                  <div className="project-footer">
                    <span>
                      Created{" "}
                      {new Date(project.created_at).toLocaleDateString(
                        "en-US",
                        { month: "short", day: "numeric" },
                      )}
                    </span>
                    <button
                      className="icon-button danger-icon"
                      title={`Delete ${project.name}`}
                      aria-label={`Delete ${project.name}`}
                      onClick={() => {
                        setDeleting(project);
                        setDeleteName("");
                        setError("");
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <Database size={38} strokeWidth={1.3} />
              </div>
              <h2>{search ? "No matching projects" : "No projects yet"}</h2>
              {search ? (
                <button className="secondary" onClick={() => setSearch("")}>
                  Clear search
                </button>
              ) : (
                <button
                  className="secondary"
                  onClick={() => {
                    setError("");
                    setCreateOpen(true);
                  }}
                >
                  <Plus size={17} />
                  Create project
                </button>
              )}
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              <span className="status-dot" />
              Workspace connected
            </span>
            <span>amazeDB / v0.1</span>
          </footer>
        </main>
      </div>

      {createOpen && (
        <Modal
          title="Create project"
          busy={busy}
          onClose={() => setCreateOpen(false)}
        >
          <form onSubmit={createProject}>
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              name="name"
              placeholder="my-first-project"
              required
              maxLength={64}
              autoFocus
            />
            <dl className="provisioning-details">
              <div>
                <dt>Database</dt>
                <dd>PostgreSQL</dd>
              </div>
              <div>
                <dt>Isolation</dt>
                <dd>Dedicated schema & role</dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>Local</dd>
              </div>
            </dl>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Plus size={17} />
                )}
                Create project
              </button>
            </div>
          </form>
        </Modal>
      )}

      {created && (
        <Modal title="Project created" onClose={() => setCreated(null)}>
          <div className="success-line">
            <Check size={18} />
            {created.project.name}
          </div>
          <h3 className="section-label">
            <KeyRound size={16} />
            API keys
          </h3>
          <p className="security-notice">
            Shown once. Keep the service-role key secret.
          </p>
          <CopyValue label="Anon key" value={created.keys.anon} />
          <CopyValue
            label="Service-role key"
            value={created.keys.service}
            secret
          />
          <div className="dialog-actions">
            <button
              className="primary"
              onClick={() => {
                setSelected(created.project);
                setCreated(null);
              }}
            >
              Open project
              <ArrowRight size={17} />
            </button>
          </div>
        </Modal>
      )}

      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)}>
          <div className="detail-status">
            <span className="status-dot" />
            Database provisioned
          </div>
          <CopyValue label="Project ID" value={selected.id} />
          <CopyValue label="Database schema" value={selected.schema_name} />
          <CopyValue
            label="Reserved API path"
            value={`/api/projects/${selected.id}/rest/v1`}
          />
          <dl className="provisioning-details">
            <div>
              <dt>Database</dt>
              <dd>PostgreSQL</dd>
            </div>
            <div>
              <dt>Tables</dt>
              <dd>{selected.table_count}</dd>
            </div>
            <div>
              <dt>REST gateway</dt>
              <dd>Not implemented</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(selected.created_at).toLocaleDateString()}</dd>
            </div>
          </dl>
          <div className="dialog-actions">
            <button
              className="secondary danger-text"
              onClick={() => {
                setDeleting(selected);
                setSelected(null);
                setDeleteName("");
                setError("");
              }}
            >
              <Trash2 size={16} />
              Delete project
            </button>
            <button className="primary" onClick={() => setSelected(null)}>
              Done
              <Check size={17} />
            </button>
            <Link className="primary" href={`/projects/${selected.id}`}>
              <Database size={17} />
              Table editor
            </Link>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal
          title="Delete project"
          busy={busy}
          onClose={() => setDeleting(null)}
        >
          <p className="deletion-notice">
            This permanently deletes <strong>{deleting.name}</strong>, its
            schema, and all its data.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void deleteProject();
            }}
          >
            <label htmlFor="delete-name">Confirm project name</label>
            <input
              id="delete-name"
              value={deleteName}
              onChange={(event) => setDeleteName(event.target.value)}
              autoComplete="off"
              required
              autoFocus
            />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                className="danger"
                disabled={busy || deleteName !== deleting.name}
              >
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Trash2 size={17} />
                )}
                Delete project
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
