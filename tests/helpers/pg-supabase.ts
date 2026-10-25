import type { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

// Just enough of the Supabase client to run worker/store.ts against a real
// Postgres: rpc() calls the SQL function with NAMED arguments (so a misspelled
// parameter in the store fails here, not in production), and from() builds the
// handful of select/insert/update queries the store makes. Not a general
// PostgREST: anything the store does not use is not supported.

type Result = { data: unknown; error: { message: string } | null };
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Unsupported identifier ${name}`);
  return name;
};

function splitColumns(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// "id, migrations(version)" -> columns plus a to_jsonb subselect for the embed,
// joined on the singular foreign key convention (migrations -> migration_id).
function selectList(cols: string): string {
  if (cols.trim() === "*") return "t.*";
  return splitColumns(cols)
    .map((c) => {
      const embed = c.match(/^([a-z_]+)\((.*)\)$/);
      if (!embed) return `t.${ident(c)}`;
      const table = ident(embed[1]);
      const fk = `${table.replace(/s$/, "")}_id`;
      const inner = splitColumns(embed[2])
        .map((x) => `e.${ident(x)}`)
        .join(", ");
      return `(select to_jsonb(x) from (select ${inner} from ${table} e where e.id = t.${fk}) x) as ${table}`;
    })
    .join(", ");
}

class Builder implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" = "select";
  private cols = "*";
  private returning: string | null = null;
  private values: Record<string, unknown> = {};
  private filters: [string, unknown][] = [];
  private orderBy: string | null = null;

  constructor(
    private readonly pg: Client,
    private readonly table: string
  ) {
    ident(table);
  }

  select(cols = "*") {
    if (this.op === "select") this.cols = cols;
    else this.returning = cols;
    return this;
  }
  insert(values: Record<string, unknown>) {
    this.op = "insert";
    this.values = values;
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = "update";
    this.values = values;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([ident(column), value]);
    return this;
  }
  order(column: string) {
    this.orderBy = ident(column);
    return this;
  }
  single() {
    return this.run("single");
  }
  maybeSingle() {
    return this.run("maybe");
  }
  then<A, B>(onOk?: (v: Result) => A | PromiseLike<A>, onErr?: (e: unknown) => B | PromiseLike<B>) {
    return this.run("many").then(onOk, onErr);
  }

  private async run(mode: "many" | "single" | "maybe"): Promise<Result> {
    try {
      const params: unknown[] = [];
      const where = this.filters.length
        ? ` where ${this.filters.map(([c, v]) => `t.${c} = $${params.push(v)}`).join(" and ")}`
        : "";
      let sql: string;
      if (this.op === "select") {
        sql = `select ${selectList(this.cols)} from ${this.table} t${where}${this.orderBy ? ` order by t.${this.orderBy}` : ""}`;
      } else if (this.op === "insert") {
        const keys = Object.keys(this.values).map(ident);
        const marks = keys.map((k) => `$${params.push(this.values[k])}`);
        sql = `insert into ${this.table} as t (${keys.join(", ")}) values (${marks.join(", ")})${this.returning ? ` returning ${selectList(this.returning)}` : ""}`;
      } else {
        const sets = Object.keys(this.values).map(
          (k) => `${ident(k)} = $${params.push(this.values[k])}`
        );
        sql = `update ${this.table} as t set ${sets.join(", ")}${where}${this.returning ? ` returning ${selectList(this.returning)}` : ""}`;
      }
      const res = await this.pg.query(sql, params);
      const rows = res.rows;
      if (this.op === "update" && !this.returning) return { data: null, error: null };
      if (mode === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: `expected one row, got ${rows.length}` } };
      }
      if (mode === "maybe") {
        if (rows.length > 1) return { data: null, error: { message: "more than one row" } };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }
}

// supabase-js sends every argument as JSON, so an object, or an array of objects,
// arrives at a jsonb parameter as JSON. node-postgres would turn an array into a
// Postgres array literal instead, so encode those the way the real client does.
// (Arrays of plain strings stay arrays: they feed text[] parameters.)
function encode(v: unknown): unknown {
  if (v === null || typeof v !== "object" || v instanceof Date) return v;
  if (Array.isArray(v) && !v.some((x) => x !== null && typeof x === "object")) return v;
  return JSON.stringify(v);
}

export function pgSupabase(pg: Client): SupabaseClient {
  const client = {
    from: (table: string) => new Builder(pg, table),
    async rpc(name: string, args: Record<string, unknown> = {}): Promise<Result> {
      try {
        const keys = Object.keys(args).map(ident);
        const call = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
        const res = await pg.query(
          `select * from ${ident(name)}(${call})`,
          keys.map((k) => encode(args[k]))
        );
        if (res.fields.length === 1 && res.fields[0].name === name) {
          const v = res.rows[0]?.[name];
          return { data: v === "" ? null : v, error: null }; // void functions come back as ''
        }
        return { data: res.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
  return client as unknown as SupabaseClient;
}
