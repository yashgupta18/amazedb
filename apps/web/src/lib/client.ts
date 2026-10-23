export type JsonRecord = Record<string, unknown>;
export type AuthUser = { id: string; email: string };
export type AuthSession = {
  user: AuthUser;
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  refresh_token: string;
};

type ClientOptions = { fetch?: typeof fetch };
type AuthCredentials = { email: string; password: string };
type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "is"
  | "in";

export class AmazeDBError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AmazeDBError";
  }
}

class RestQuery<T extends JsonRecord> {
  private readonly query = new URLSearchParams();
  private method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private body: unknown;

  constructor(
    private readonly client: AmazeDBClient,
    private readonly table: string,
  ) {}

  select(columns = "*") {
    this.query.set("select", columns);
    return this;
  }

  private filter(column: string, operator: FilterOperator, value: unknown) {
    const encoded =
      operator === "in"
        ? `in.(${(value as unknown[]).map(String).join(",")})`
        : `${operator}.${value === null ? "null" : String(value)}`;
    this.query.append(column, encoded);
    return this;
  }

  eq(column: string, value: unknown) {
    return this.filter(column, "eq", value);
  }
  neq(column: string, value: unknown) {
    return this.filter(column, "neq", value);
  }
  gt(column: string, value: unknown) {
    return this.filter(column, "gt", value);
  }
  gte(column: string, value: unknown) {
    return this.filter(column, "gte", value);
  }
  lt(column: string, value: unknown) {
    return this.filter(column, "lt", value);
  }
  lte(column: string, value: unknown) {
    return this.filter(column, "lte", value);
  }
  like(column: string, value: string) {
    return this.filter(column, "like", value);
  }
  ilike(column: string, value: string) {
    return this.filter(column, "ilike", value);
  }
  is(column: string, value: null | boolean) {
    return this.filter(column, "is", value);
  }
  in(column: string, values: unknown[]) {
    return this.filter(column, "in", values);
  }

  order(
    column: string,
    options: { ascending?: boolean; nullsFirst?: boolean } = {},
  ) {
    const part = `${column}.${options.ascending === false ? "desc" : "asc"}${options.nullsFirst === undefined ? "" : options.nullsFirst ? ".nullsfirst" : ".nullslast"}`;
    const previous = this.query.get("order");
    this.query.set("order", previous ? `${previous},${part}` : part);
    return this;
  }

  limit(value: number) {
    this.query.set("limit", String(value));
    return this;
  }

  range(from: number, to: number) {
    this.query.set("offset", String(from));
    this.query.set("limit", String(to - from + 1));
    return this;
  }

  insert(values: JsonRecord | JsonRecord[]) {
    this.method = "POST";
    this.body = values;
    return this;
  }

  update(values: JsonRecord) {
    this.method = "PATCH";
    this.body = values;
    return this;
  }

  delete() {
    this.method = "DELETE";
    return this;
  }

  async execute(): Promise<T[]> {
    return this.client.request<T[]>(
      `/api/rest/v1/${this.client.projectId}/${encodeURIComponent(this.table)}${this.query.size ? `?${this.query}` : ""}`,
      this.method,
      this.body,
    );
  }
}

export class AmazeDBClient {
  private readonly fetcher: typeof fetch;
  private session: AuthSession | null = null;
  readonly projectId: string;
  readonly auth: {
    signUp: (credentials: AuthCredentials) => Promise<AuthSession>;
    signIn: (credentials: AuthCredentials) => Promise<AuthSession>;
    refreshSession: () => Promise<AuthSession>;
    signOut: () => Promise<void>;
    getSession: () => AuthSession | null;
  };

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    options: ClientOptions = {},
  ) {
    const parsed = new URL(baseUrl);
    const match = /\/api\/rest\/v1\/([^/]+)\/?$/.exec(parsed.pathname);
    if (!match) throw new Error("URL must end with /api/rest/v1/:projectId.");
    this.projectId = decodeURIComponent(match[1]);
    this.fetcher = options.fetch ?? globalThis.fetch;
    const authUrl = `/api/auth/v1/${this.projectId}`;
    this.auth = {
      signUp: (credentials) => this.authRequest(authUrl, "signup", credentials),
      signIn: (credentials) => this.authRequest(authUrl, "login", credentials),
      refreshSession: async () => {
        if (!this.session)
          throw new AmazeDBError("No active session to refresh.", 401);
        const session = await this.authRequest(authUrl, "refresh", {
          refresh_token: this.session.refresh_token,
        });
        return session;
      },
      signOut: async () => {
        if (!this.session) return;
        try {
          await this.authRequest(authUrl, "logout", {
            refresh_token: this.session.refresh_token,
          });
        } finally {
          this.session = null;
        }
      },
      getSession: () => this.session,
    };
  }

  from<T extends JsonRecord = JsonRecord>(table: string) {
    return new RestQuery<T>(this, table);
  }

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method,
      headers: {
        apikey: this.apiKey,
        ...(this.session
          ? { Authorization: `Bearer ${this.session.access_token}` }
          : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        result &&
        typeof result === "object" &&
        "error" in result &&
        typeof result.error === "string"
          ? result.error
          : `Request failed with status ${response.status}.`;
      throw new AmazeDBError(message, response.status);
    }
    return result as T;
  }

  private async authRequest(authUrl: string, action: string, body: unknown) {
    const session = await this.request<AuthSession>(
      `${authUrl}/${action}`,
      "POST",
      body,
    );
    if (action !== "logout") this.session = session;
    return session;
  }
}

export function createClient(
  url: string,
  anonKey: string,
  options: ClientOptions = {},
) {
  return new AmazeDBClient(url, anonKey, options);
}
