import { describe, expect, it } from "vitest";
import {
  MigrationFileError,
  checksumOf,
  findContractRisks,
  maskLiterals,
  normalizeSql,
  parseMigration,
  stripTransactionWrapper,
} from "@/lib/migrate/parse";

const TAG = "a".repeat(40);
const file = "20261024100000_add_things.sql";

describe("parseMigration", () => {
  it("reads version, name and an expand default", () => {
    const m = parseMigration(file, "create table t (id int);");
    expect(m).toMatchObject({
      version: "20261024100000",
      name: "20261024100000_add_things",
      kind: "expand",
      minAppVersion: null,
    });
    expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    "add_things.sql",
    "2026_add.sql",
    "20261024100000_Add.sql",
    "20261024100000_a-b.sql",
    "20261024100000.sql",
    "20261024100000_x.txt",
  ])("refuses the file name %s", (name) => {
    expect(() => parseMigration(name, "select 1;")).toThrow(MigrationFileError);
  });

  it("refuses an empty file", () => {
    expect(() => parseMigration(file, "  \n ")).toThrow(/empty/);
  });

  it("gives the same checksum for LF, CRLF and a BOM", () => {
    const lf = parseMigration(file, "create table t (\n id int\n);\n");
    const crlf = parseMigration(file, "\uFEFFcreate table t (\r\n id int\r\n);\r\n");
    expect(crlf.checksum).toBe(lf.checksum);
    expect(crlf.sql).toBe(lf.sql);
  });

  it("changes the checksum when the SQL changes", () => {
    expect(parseMigration(file, "select 1;").checksum).not.toBe(
      parseMigration(file, "select 2;").checksum
    );
  });

  describe("the header", () => {
    it("reads a contract declaration", () => {
      const m = parseMigration(
        file,
        `-- control-plane: kind=contract min_app_version=${TAG}\nalter table t drop column c;`
      );
      expect(m).toMatchObject({ kind: "contract", minAppVersion: TAG });
    });
    it("needs min_app_version for a contract", () => {
      expect(() => parseMigration(file, "-- control-plane: kind=contract\nselect 1;")).toThrow(
        /min_app_version/
      );
    });
    it("refuses min_app_version on an expand", () => {
      expect(() =>
        parseMigration(file, `-- control-plane: kind=expand min_app_version=${TAG}\nselect 1;`)
      ).toThrow(/only applies/);
    });
    it.each([
      ["kind=sideways", /kind must be/],
      ["min_app_version=abc kind=contract", /40-character/],
      ["colour=red", /unrecognised/],
    ])("refuses the header %s", (header, message) => {
      expect(() => parseMigration(file, `-- control-plane: ${header}\nselect 1;`)).toThrow(message);
    });
    it("ignores a header further down than the first lines", () => {
      const sql = `${"-- note\n".repeat(20)}-- control-plane: kind=contract min_app_version=${TAG}\nselect 1;`;
      expect(parseMigration(file, sql).kind).toBe("expand");
    });
  });

  describe("contract risks", () => {
    it.each([
      "alter table t drop column c;",
      "drop table t;",
      "alter table t alter column c type bigint;",
      "alter table t alter column c set not null;",
      "alter table t rename column a to b;",
      "alter table t rename to u;",
      "alter table t drop constraint k;",
      "truncate t;",
      "drop type mood;",
    ])("an unmarked expand migration is refused for: %s", (sql) => {
      expect(() => parseMigration(file, sql)).toThrow(/contract/);
    });

    it.each([
      "drop policy if exists p on t; create policy p on t for select using (true);",
      "drop function if exists f(); create function f() returns int language sql as $$ select 1 $$;",
      "drop trigger if exists tg on t;",
      "create table t (id int); alter table t add column c int;",
      "-- drop table t;\ncreate table x (id int);",
      "create function f() returns void language plpgsql as $$ begin execute 'drop table y'; end $$;",
    ])("an additive or idempotent migration passes: %s", (sql) => {
      expect(() => parseMigration(file, sql)).not.toThrow();
    });

    it("allows a declared contract migration with risks", () => {
      expect(() =>
        parseMigration(
          file,
          `-- control-plane: kind=contract min_app_version=${TAG}\ndrop table t;`
        )
      ).not.toThrow();
    });

    it("does not lint a baseline migration", () => {
      expect(() => parseMigration(file, "drop table t;", { baseline: true })).not.toThrow();
    });

    it("lists every reason", () => {
      expect(findContractRisks("drop table a; alter table b drop column c;")).toEqual([
        "drops a table",
        "drops a column",
      ]);
    });
  });

  describe("transactions", () => {
    it.each([
      "create index concurrently i on t (c);",
      "vacuum t;",
      "create database x;",
      "alter system set work_mem = '1GB';",
    ])("refuses a statement that cannot run in a transaction: %s", (sql) => {
      expect(() => parseMigration(file, sql)).toThrow(/inside a transaction/);
    });

    it("refuses a COMMIT in the middle of the file", () => {
      expect(() =>
        parseMigration(file, "create table a (id int);\ncommit;\ncreate table b (id int);")
      ).toThrow(/manages its own transaction/);
    });

    it("refuses BEGIN without COMMIT", () => {
      expect(() => parseMigration(file, "begin;\ncreate table a (id int);")).toThrow(
        /BEGIN without/
      );
    });

    it("allows plpgsql BEGIN ... END inside a function body", () => {
      const sql =
        "create function f() returns void language plpgsql as $$ begin perform 1; end; $$;";
      expect(() => parseMigration(file, sql)).not.toThrow();
    });
  });
});

describe("stripTransactionWrapper", () => {
  it("removes a matching BEGIN/COMMIT pair and keeps the statements", () => {
    const out = stripTransactionWrapper(
      "-- hi\nbegin;\ncreate table a (id int);\ncreate table b (id int);\ncommit;\n"
    );
    expect(out).not.toMatch(/begin|commit/i);
    expect(out).toContain("create table a (id int);");
    expect(out).toContain("create table b (id int);");
  });
  it("leaves an unwrapped file alone", () => {
    const sql = "create table a (id int);";
    expect(stripTransactionWrapper(sql)).toBe(sql);
  });
  it("does not mistake a function's BEGIN for a wrapper", () => {
    const sql = "create function f() returns void language plpgsql as $$ begin null; end $$;";
    expect(stripTransactionWrapper(sql)).toBe(sql);
  });
});

describe("maskLiterals", () => {
  it("hides comments, strings and dollar-quoted bodies but keeps length", () => {
    const sql =
      "select 'drop table x'; -- drop table y\n/* drop table z */ select $$drop table w$$;";
    const masked = maskLiterals(sql);
    expect(masked.length).toBe(sql.length);
    expect(masked).not.toMatch(/drop/);
    expect(masked).toContain("select");
  });
  it("handles an escaped quote and nested comments", () => {
    expect(maskLiterals("select 'it''s drop'; /* a /* drop */ drop */ select 1;")).not.toMatch(
      /drop/
    );
  });
});

describe("helpers", () => {
  it("normalizeSql strips the BOM and CRs", () => {
    expect(normalizeSql("\uFEFFa\r\nb\rc")).toBe("a\nb\nc");
  });
  it("checksumOf is sha256 hex", () => {
    expect(checksumOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
