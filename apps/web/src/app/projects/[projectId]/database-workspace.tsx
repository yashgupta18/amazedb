"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Database,
  KeyRound,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { api, Modal } from "@/app/workspace";
import {
  columnTypes,
  type SqlResult,
  type TableData,
  type TableInfo,
} from "@/lib/database-types";
import type { Project } from "@/server/control-plane";

type NewColumn = {
  name: string;
  type: (typeof columnTypes)[number];
  nullable: boolean;
};
type Draft = { mode: "value" | "null" | "default"; value: string };
type Row = Record<string, unknown>;
type Policy = {
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
};

function displayValue(value: unknown) {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

function ColumnFields({
  column,
  onChange,
  prefix,
}: {
  column: NewColumn;
  onChange: (column: NewColumn) => void;
  prefix: string;
}) {
  return (
    <div className="column-fields">
      <div>
        <label htmlFor={`${prefix}-name`}>Name</label>
        <input
          id={`${prefix}-name`}
          aria-label={`${prefix} name`}
          value={column.name}
          onChange={(event) =>
            onChange({ ...column, name: event.target.value })
          }
          required
          pattern="[a-z_][a-z0-9_]{0,62}"
          maxLength={63}
        />
      </div>
      <div>
        <label htmlFor={`${prefix}-type`}>Type</label>
        <select
          id={`${prefix}-type`}
          aria-label={`${prefix} type`}
          value={column.type}
          onChange={(event) =>
            onChange({
              ...column,
              type: event.target.value as NewColumn["type"],
            })
          }
        >
          {columnTypes.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          aria-label={`${prefix} nullable`}
          checked={column.nullable}
          onChange={(event) =>
            onChange({ ...column, nullable: event.target.checked })
          }
        />
        Nullable
      </label>
    </div>
  );
}

export default function DatabaseWorkspace({
  projectId,
}: {
  projectId: string;
}) {
  const router = useRouter();
  const base = `projects/${projectId}`;
  const [project, setProject] = useState<Project | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [data, setData] = useState<TableData | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"tables" | "sql" | "policies">("tables");
  const [modal, setModal] = useState<
    "table" | "column" | "row" | "delete" | null
  >(null);
  const [newColumns, setNewColumns] = useState<NewColumn[]>([
    { name: "title", type: "text", nullable: false },
  ]);
  const [newColumn, setNewColumn] = useState<NewColumn>({
    name: "",
    type: "text",
    nullable: true,
  });
  const [editing, setEditing] = useState<Row | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sql, setSql] = useState("SELECT current_user;");
  const [sqlResult, setSqlResult] = useState<SqlResult | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policyName, setPolicyName] = useState("owner_access");
  const [policyOwnerColumn, setPolicyOwnerColumn] = useState("");
  const [policyCommand, setPolicyCommand] = useState<
    "all" | "select" | "insert" | "update" | "delete"
  >("all");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = await api("auth/session");
        if (!session.account) {
          router.replace("/");
          return;
        }
        const [projects, result] = await Promise.all([
          api("projects"),
          api(`${base}/tables`),
        ]);
        const current = projects.projects.find(
          (entry: Project) => entry.id === projectId,
        );
        if (!current) throw new Error("Project not found.");
        if (active) {
          setProject(current);
          setTables(result.tables);
          setSelected(result.tables[0]?.name ?? "");
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
  }, [base, projectId, router]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    async function loadRows() {
      setRowsLoading(true);
      try {
        const result = await api(
          `${base}/tables/${encodeURIComponent(selected)}/rows?page=${page}`,
        );
        if (active) setData(result);
      } catch (caught) {
        if (active) {
          setError((caught as Error).message);
          setData(null);
        }
      } finally {
        if (active) setRowsLoading(false);
      }
    }
    void loadRows();
    return () => {
      active = false;
    };
  }, [base, selected, page]);

  useEffect(() => {
    if (tab !== "policies" || !selected) return;
    let active = true;
    void api(`${base}/policies/${encodeURIComponent(selected)}`)
      .then((result) => {
        if (active) setPolicies(result.policies);
      })
      .catch((caught) => {
        if (active) setError((caught as Error).message);
      });
    return () => {
      active = false;
    };
  }, [base, selected, tab]);

  async function refreshTables(preferred = selected) {
    const result = await api(`${base}/tables`);
    setTables(result.tables);
    const next = result.tables.some(
      (table: TableInfo) => table.name === preferred,
    )
      ? preferred
      : (result.tables[0]?.name ?? "");
    setSelected(next);
    if (!next) setData(null);
    return next as string;
  }

  async function refreshRows(table = selected, currentPage = page) {
    if (!table) return;
    const result: TableData = await api(
      `${base}/tables/${encodeURIComponent(table)}/rows?page=${currentPage}`,
    );
    if (!result.rows.length && currentPage > 0) {
      setPage(currentPage - 1);
      return;
    }
    setData(result);
  }

  async function refreshPolicies(table = selected) {
    if (!table) return;
    const result = await api(`${base}/policies/${encodeURIComponent(table)}`);
    setPolicies(result.policies);
  }

  async function createPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await perform(async () => {
      const uuidColumns =
        data?.columns.filter((column) => column.type === "uuid") ?? [];
      const ownerColumn =
        uuidColumns.find((column) => column.name === policyOwnerColumn) ??
        uuidColumns[0];
      if (!ownerColumn)
        throw new Error("This table needs a UUID owner column.");
      await api(`${base}/policies/${encodeURIComponent(selected)}`, "POST", {
        name: policyName,
        ownerColumn: ownerColumn.name,
        command: policyCommand,
      });
      await refreshPolicies();
      setError("");
    });
  }

  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openRow(row: Row | null) {
    setEditing(row);
    setError("");
    setDrafts(
      Object.fromEntries(
        (data?.columns ?? [])
          .filter((column) => !column.generated && !(row && column.primary_key))
          .map((column) => {
            const value = row?.[column.name];
            const draft: Draft = row
              ? {
                  mode: value === null ? "null" : "value",
                  value: value === null ? "" : displayValue(value),
                }
              : {
                  mode:
                    column.nullable || column.has_default ? "default" : "value",
                  value: column.type === "boolean" ? "false" : "",
                };
            return [column.name, draft];
          }),
      ),
    );
    setModal("row");
  }

  function rowKey(row: Row) {
    return Object.fromEntries(
      (data?.columns ?? [])
        .filter((column) => column.primary_key)
        .map((column) => [column.name, row[column.name]]),
    );
  }

  async function saveRow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await perform(async () => {
      const values: Row = {};
      for (const column of data?.columns ?? []) {
        const draft = drafts[column.name];
        if (!draft || draft.mode === "default") continue;
        if (
          editing &&
          ((draft.mode === "null" && editing[column.name] === null) ||
            (draft.mode === "value" &&
              editing[column.name] !== null &&
              draft.value === displayValue(editing[column.name])))
        )
          continue;
        if (draft.mode === "null") values[column.name] = null;
        else if (column.type === "boolean")
          values[column.name] = draft.value === "true";
        else if (
          ["json", "jsonb"].includes(column.type) ||
          column.type.endsWith("[]")
        ) {
          try {
            values[column.name] = JSON.parse(draft.value);
          } catch {
            throw new Error(`Invalid JSON in ${column.name}.`);
          }
        } else values[column.name] = draft.value;
      }
      if (!editing || Object.keys(values).length)
        await api(
          `${base}/tables/${encodeURIComponent(selected)}/rows`,
          editing ? "PATCH" : "POST",
          { values, ...(editing ? { key: rowKey(editing) } : {}) },
        );
      setModal(null);
      await refreshRows();
    });
  }

  if (loading)
    return (
      <main className="loading-screen">
        <Database size={26} />
        <LoaderCircle className="spin" aria-label="Loading project" />
      </main>
    );
  if (!project)
    return (
      <main className="project-unavailable">
        <Link className="secondary" href="/">
          <ArrowLeft size={16} />
          Projects
        </Link>
        <p role="alert" className="error">
          {error || "Project not found."}
        </p>
      </main>
    );
  const hasPrimary =
    data?.columns.some((column) => column.primary_key) ?? false;
  const tableReady = Boolean(selected && data && !rowsLoading);
  const uuidColumns =
    data?.columns.filter((column) => column.type === "uuid") ?? [];
  const selectedOwnerColumn = uuidColumns.some(
    (column) => column.name === policyOwnerColumn,
  )
    ? policyOwnerColumn
    : (uuidColumns[0]?.name ?? "");

  return (
    <div className="database-workspace">
      <header className="database-header">
        <Link className="database-back" href="/" title="Back to projects">
          <ArrowLeft size={18} />
          <Database size={21} />
          <span>amazeDB</span>
        </Link>
        <ChevronRight size={15} />
        <strong>{project.name}</strong>
        <span className="environment">
          <span className="status-dot" />
          Local PostgreSQL
        </span>
      </header>
      <div className="database-tabs" role="tablist" aria-label="Project tools">
        <button
          role="tab"
          aria-selected={tab === "tables"}
          aria-controls="table-panel"
          id="table-tab"
          onClick={() => {
            setTab("tables");
            setError("");
          }}
          disabled={busy}
        >
          <Table2 size={16} />
          Table editor
        </button>
        <button
          role="tab"
          aria-selected={tab === "sql"}
          aria-controls="sql-panel"
          id="sql-tab"
          onClick={() => {
            setTab("sql");
            setError("");
          }}
          disabled={busy}
        >
          <Code2 size={16} />
          SQL editor
        </button>
        <button
          role="tab"
          aria-selected={tab === "policies"}
          aria-controls="policies-panel"
          id="policies-tab"
          onClick={() => {
            setTab("policies");
            setError("");
          }}
          disabled={busy}
        >
          <ShieldCheck size={16} />
          RLS policies
        </button>
        <code className="schema-label" title={project.schema_name}>
          {project.schema_name}
        </code>
      </div>

      {tab === "tables" ? (
        <div
          id="table-panel"
          role="tabpanel"
          aria-labelledby="table-tab"
          className="database-body"
        >
          <aside className="table-sidebar">
            <div className="table-list-heading">
              <h2>
                Tables <span>{tables.length}</span>
              </h2>
              <button
                className="icon-button"
                title="Create table"
                aria-label="Create table"
                disabled={busy}
                onClick={() => {
                  setModal("table");
                  setError("");
                  setNewColumns([
                    { name: "title", type: "text", nullable: false },
                  ]);
                }}
              >
                <Plus size={17} />
              </button>
            </div>
            <nav aria-label="Tables">
              {tables.map((table) => (
                <button
                  key={table.name}
                  title={table.name}
                  className={
                    selected === table.name ? "table-nav selected" : "table-nav"
                  }
                  disabled={busy}
                  onClick={() => {
                    setSelected(table.name);
                    setPage(0);
                    setData(null);
                    setError("");
                  }}
                >
                  <Table2 size={15} />
                  <span>{table.name}</span>
                  <small>{table.column_count}</small>
                </button>
              ))}
            </nav>
            {!tables.length && <p className="sidebar-empty">No tables</p>}
          </aside>
          <main className="table-main">
            <div className="table-toolbar">
              <h1>{selected || "Tables"}</h1>
              <div className="tool-actions">
                <button
                  className="icon-button"
                  title="Refresh tables and rows"
                  aria-label="Refresh tables and rows"
                  disabled={busy || rowsLoading}
                  onClick={() =>
                    void perform(async () => {
                      const next = await refreshTables();
                      await refreshRows(next);
                    })
                  }
                >
                  <RefreshCw size={16} />
                </button>
                <button
                  className="secondary"
                  disabled={!tableReady || busy}
                  onClick={() => {
                    setNewColumn({ name: "", type: "text", nullable: true });
                    setModal("column");
                    setError("");
                  }}
                >
                  <Plus size={16} />
                  Column
                </button>
                <button
                  className="primary"
                  disabled={!tableReady || busy}
                  onClick={() => openRow(null)}
                >
                  <Plus size={16} />
                  Insert row
                </button>
              </div>
            </div>
            {error && !modal && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {!tables.length ? (
              <div className="database-empty">
                <Table2 size={38} strokeWidth={1.3} />
                <h2>No tables yet</h2>
                <button
                  className="primary"
                  onClick={() => {
                    setModal("table");
                    setError("");
                  }}
                >
                  <Plus size={16} />
                  Create your first table
                </button>
              </div>
            ) : rowsLoading ? (
              <div className="database-empty">
                <LoaderCircle className="spin" aria-label="Loading rows" />
              </div>
            ) : data ? (
              <>
                <div className="data-grid-scroll">
                  <table className="data-grid">
                    <thead>
                      <tr>
                        {data.columns.map((column) => (
                          <th key={column.name}>
                            <span>
                              {column.primary_key && (
                                <KeyRound size={12} aria-label="Primary key" />
                              )}{" "}
                              {column.name}
                            </span>
                            <small>{column.type}</small>
                          </th>
                        ))}
                        <th className="row-actions-header">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row, index) => (
                        <tr
                          key={JSON.stringify(hasPrimary ? rowKey(row) : index)}
                        >
                          {data.columns.map((column) => (
                            <td
                              key={column.name}
                              title={displayValue(row[column.name])}
                              className={
                                row[column.name] === null ? "null-cell" : ""
                              }
                            >
                              {displayValue(row[column.name])}
                            </td>
                          ))}
                          <td className="row-actions">
                            <button
                              className="icon-button"
                              aria-label={`Edit row ${page * 50 + index + 1}`}
                              title={
                                hasPrimary ? "Edit row" : "Primary key required"
                              }
                              disabled={!hasPrimary || busy}
                              onClick={() => openRow(row)}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="icon-button danger-icon"
                              aria-label={`Delete row ${page * 50 + index + 1}`}
                              title={
                                hasPrimary
                                  ? "Delete row"
                                  : "Primary key required"
                              }
                              disabled={!hasPrimary || busy}
                              onClick={() => {
                                setEditing(row);
                                setModal("delete");
                                setError("");
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!data.rows.length && <div className="no-rows">No rows</div>}
                <footer className="pagination">
                  <span>
                    {data.rows.length} rows on this page
                    {!hasPrimary && " / No primary key"}
                  </span>
                  <div>
                    <button
                      className="icon-button"
                      aria-label="Previous page"
                      title="Previous page"
                      disabled={page === 0 || busy}
                      onClick={() => setPage(page - 1)}
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <span>Page {page + 1}</span>
                    <button
                      className="icon-button"
                      aria-label="Next page"
                      title="Next page"
                      disabled={!data.hasMore || busy}
                      onClick={() => setPage(page + 1)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                </footer>
              </>
            ) : null}
          </main>
        </div>
      ) : tab === "sql" ? (
        <main
          id="sql-panel"
          role="tabpanel"
          aria-labelledby="sql-tab"
          className="sql-panel"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                setSqlResult(null);
                const result = await api(`${base}/sql`, "POST", { sql });
                setSqlResult(result);
                const next = await refreshTables();
                setPage(0);
                await refreshRows(next, 0);
              });
            }}
          >
            <div className="sql-toolbar">
              <label htmlFor="sql-query">SQL query</label>
              <span className="sql-limit">5s timeout / 200 result rows</span>
              <button className="primary" disabled={busy || !sql.trim()}>
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Play size={16} />
                )}
                Run query
              </button>
            </div>
            <textarea
              id="sql-query"
              className="sql-input"
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              spellCheck={false}
              maxLength={20_000}
              disabled={busy}
            />
          </form>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <section className="sql-results" aria-label="Query results">
            <div className="results-heading">
              <h2>Results</h2>
              {sqlResult && (
                <span>
                  <Check size={14} />
                  {sqlResult.command} / {sqlResult.rows.length} rows shown
                  {sqlResult.truncated ? " / truncated" : ""}
                  {sqlResult.rowCount !== null
                    ? ` / ${sqlResult.rowCount} affected`
                    : ""}
                </span>
              )}
            </div>
            {sqlResult?.columns.length ? (
              <div className="data-grid-scroll">
                <table className="data-grid">
                  <thead>
                    <tr>
                      {sqlResult.columns.map((column, index) => (
                        <th scope="col" key={`${index}:${column}`}>
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sqlResult.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((value, column) => (
                          <td
                            key={column}
                            title={displayValue(value)}
                            className={value === null ? "null-cell" : ""}
                          >
                            {displayValue(value)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!sqlResult.rows.length && (
                  <div className="no-rows">No rows returned</div>
                )}
              </div>
            ) : (
              <div className="no-rows">
                {sqlResult ? "Statement completed" : "No query results"}
              </div>
            )}
          </section>
        </main>
      ) : (
        <main
          id="policies-panel"
          role="tabpanel"
          aria-labelledby="policies-tab"
          className="policies-panel"
        >
          <div className="policies-heading">
            <div>
              <p className="eyebrow">ROW LEVEL SECURITY</p>
              <h1>Policies</h1>
            </div>
            <label htmlFor="policy-table">
              Table
              <select
                id="policy-table"
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setPage(0);
                  setData(null);
                  setPolicies([]);
                  setError("");
                }}
                disabled={busy || !tables.length}
              >
                {tables.map((table) => (
                  <option key={table.name} value={table.name}>
                    {table.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="policy-warning">
            <ShieldCheck size={17} />
            Policies restrict anon and authenticated REST requests. Service-role
            requests bypass row-level policies. Until you add a policy, enabling
            RLS denies those requests for this table.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <section className="policy-section">
            <h2>
              Existing policies <span>{policies.length}</span>
            </h2>
            {policies.length ? (
              <div className="policy-list">
                {policies.map((policy) => (
                  <article className="policy-item" key={policy.policyname}>
                    <div className="policy-item-heading">
                      <strong>{policy.policyname}</strong>
                      <span>{policy.cmd}</span>
                      <button
                        className="icon-button danger-icon"
                        title={`Delete policy ${policy.policyname}`}
                        aria-label={`Delete policy ${policy.policyname}`}
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await api(
                              `${base}/policies/${encodeURIComponent(selected)}/${encodeURIComponent(policy.policyname)}`,
                              "DELETE",
                            );
                            await refreshPolicies();
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <code>
                      {policy.qual ?? policy.with_check ?? "No expression"}
                    </code>
                    <small>Roles: {policy.roles.join(", ")}</small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="no-policies">No policies for this table.</p>
            )}
          </section>
          <section className="policy-section policy-builder">
            <h2>Create an owner policy</h2>
            <p>
              Allow each authenticated user to access rows whose UUID owner
              column matches their verified user ID.
            </p>
            <form onSubmit={createPolicy}>
              <label htmlFor="policy-name">Policy name</label>
              <input
                id="policy-name"
                value={policyName}
                onChange={(event) => setPolicyName(event.target.value)}
                required
                pattern="[a-z_][a-z0-9_]{0,62}"
                maxLength={63}
              />
              <div className="policy-form-grid">
                <div>
                  <label htmlFor="owner-column">UUID owner column</label>
                  <select
                    id="owner-column"
                    value={selectedOwnerColumn}
                    onChange={(event) =>
                      setPolicyOwnerColumn(event.target.value)
                    }
                    disabled={!uuidColumns.length}
                  >
                    {uuidColumns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="policy-command">Command</label>
                  <select
                    id="policy-command"
                    value={policyCommand}
                    onChange={(event) =>
                      setPolicyCommand(
                        event.target.value as typeof policyCommand,
                      )
                    }
                  >
                    <option value="all">All</option>
                    <option value="select">Select</option>
                    <option value="insert">Insert</option>
                    <option value="update">Update</option>
                    <option value="delete">Delete</option>
                  </select>
                </div>
              </div>
              {!uuidColumns.length && (
                <p className="policy-hint">
                  Add a UUID owner column to this table before creating an
                  ownership policy.
                </p>
              )}
              <button
                className="primary"
                disabled={busy || !selectedOwnerColumn || !selected}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Plus size={16} />
                )}
                Enable RLS and create policy
              </button>
            </form>
          </section>
        </main>
      )}

      {modal === "table" && (
        <Modal title="Create table" busy={busy} onClose={() => setModal(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                const name = String(form.get("name"));
                await api(`${base}/tables`, "POST", {
                  name,
                  columns: newColumns,
                });
                setPage(0);
                await refreshTables(name);
                setModal(null);
                await refreshRows(name, 0);
              });
            }}
          >
            <label htmlFor="table-name">Table name</label>
            <input
              id="table-name"
              name="name"
              required
              pattern="[a-z_][a-z0-9_]{0,62}"
              maxLength={63}
              placeholder="todos"
              autoFocus
            />
            <div className="schema-generated">
              <KeyRound size={14} />
              <code>id</code>
              <span>bigint / identity / primary key</span>
            </div>
            {newColumns.map((column, index) => (
              <div className="new-column-row" key={index}>
                <ColumnFields
                  prefix={`Column ${index + 1}`}
                  column={column}
                  onChange={(next) =>
                    setNewColumns((current) =>
                      current.map((entry, position) =>
                        position === index ? next : entry,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove column ${index + 1}`}
                  title="Remove column"
                  onClick={() =>
                    setNewColumns((current) =>
                      current.filter((_, position) => position !== index),
                    )
                  }
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              disabled={newColumns.length >= 30}
              onClick={() =>
                setNewColumns((current) => [
                  ...current,
                  { name: "", type: "text", nullable: true },
                ])
              }
            >
              <Plus size={15} />
              Add column
            </button>
            {error && (
              <p className="error modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Table2 size={16} />
                )}
                Create table
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "column" && (
        <Modal title="Add column" busy={busy} onClose={() => setModal(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await api(
                  `${base}/tables/${encodeURIComponent(selected)}/columns`,
                  "POST",
                  newColumn,
                );
                setModal(null);
                await refreshTables();
                await refreshRows();
              });
            }}
          >
            <ColumnFields
              column={newColumn}
              prefix="New column"
              onChange={setNewColumn}
            />
            {error && (
              <p className="error modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                <Plus size={16} />
                Add column
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "row" && (
        <Modal
          title={editing ? "Edit row" : "Insert row"}
          busy={busy}
          onClose={() => setModal(null)}
        >
          <form onSubmit={saveRow}>
            {data?.columns
              .filter(
                (column) => column.generated || (editing && column.primary_key),
              )
              .map((column) => (
                <div className="generated-row-field" key={column.name}>
                  <label>{column.name}</label>
                  <code>
                    {editing ? displayValue(editing[column.name]) : "Generated"}
                  </code>
                </div>
              ))}
            {data?.columns
              .filter((column) => drafts[column.name])
              .map((column) => {
                const draft = drafts[column.name];
                const change = (next: Partial<Draft>) =>
                  setDrafts((current) => ({
                    ...current,
                    [column.name]: { ...current[column.name], ...next },
                  }));
                return (
                  <div className="row-field" key={column.name}>
                    <div className="row-field-heading">
                      <label htmlFor={`value-${column.name}`}>
                        {column.name}
                        <small>{column.type}</small>
                      </label>
                      <select
                        aria-label={`${column.name} mode`}
                        value={draft.mode}
                        onChange={(event) =>
                          change({ mode: event.target.value as Draft["mode"] })
                        }
                      >
                        <option value="value">Value</option>
                        {column.nullable && <option value="null">NULL</option>}
                        {!editing && <option value="default">Default</option>}
                      </select>
                    </div>
                    {draft.mode === "value" &&
                      (column.type === "boolean" ? (
                        <select
                          id={`value-${column.name}`}
                          value={draft.value || "false"}
                          onChange={(event) =>
                            change({ value: event.target.value })
                          }
                        >
                          <option value="false">false</option>
                          <option value="true">true</option>
                        </select>
                      ) : ["json", "jsonb"].includes(column.type) ||
                        column.type.endsWith("[]") ? (
                        <textarea
                          id={`value-${column.name}`}
                          value={draft.value}
                          onChange={(event) =>
                            change({ value: event.target.value })
                          }
                          spellCheck={false}
                        />
                      ) : (
                        <input
                          id={`value-${column.name}`}
                          value={draft.value}
                          onChange={(event) =>
                            change({ value: event.target.value })
                          }
                        />
                      ))}
                  </div>
                );
              })}
            {error && (
              <p className="error modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Save size={16} />
                )}
                {editing ? "Save changes" : "Insert row"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "delete" && editing && (
        <Modal title="Delete row" busy={busy} onClose={() => setModal(null)}>
          <p className="deletion-notice">
            Permanently delete this row from <strong>{selected}</strong>?
          </p>
          <pre className="row-key-preview">
            {JSON.stringify(rowKey(editing), null, 2)}
          </pre>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              Cancel
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api(
                    `${base}/tables/${encodeURIComponent(selected)}/rows`,
                    "DELETE",
                    { key: rowKey(editing) },
                  );
                  setModal(null);
                  await refreshRows();
                })
              }
            >
              <Trash2 size={16} />
              Delete row
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
