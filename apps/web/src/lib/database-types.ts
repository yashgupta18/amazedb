export const columnTypes = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "numeric",
  "uuid",
  "timestamptz",
  "jsonb",
] as const;
export type Column = {
  name: string;
  type: string;
  nullable: boolean;
  primary_key: boolean;
  generated: boolean;
  has_default: boolean;
};
export type TableInfo = {
  name: string;
  column_count: number;
  has_primary_key: boolean;
};
export type SqlResult = {
  columns: string[];
  rows: unknown[][];
  command: string;
  rowCount: number | null;
  truncated: boolean;
};
export type TableData = {
  columns: Column[];
  rows: Record<string, unknown>[];
  page: number;
  hasMore: boolean;
};
