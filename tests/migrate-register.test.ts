import { describe, expect, it } from "vitest";
import { checksumOf, normalizeSql } from "@/lib/migrate/parse";
import { planRegistration } from "@/lib/migrate/register";

const file = (version: string, sql: string, words = "thing") => ({
  name: `${version}_${words}.sql`,
  content: sql,
});
const row = (version: string, sql: string, words = "thing") => ({
  version,
  name: `${version}_${words}`,
  checksum: checksumOf(normalizeSql(sql)),
});

describe("planRegistration", () => {
  it("registers every file on the first run", () => {
    const plan = planRegistration(
      [
        file("20261001000000", "create table a (id int);"),
        file("20261002000000", "create table b (id int);"),
      ],
      []
    );
    expect(plan.errors).toEqual([]);
    expect(plan.newMigrations.map((m) => m.version)).toEqual(["20261001000000", "20261002000000"]);
    expect(plan.unchanged).toBe(0);
  });

  it("plans only the files it has not seen, and counts the rest as unchanged", () => {
    const sqlA = "create table a (id int);";
    const plan = planRegistration(
      [file("20261001000000", sqlA), file("20261002000000", "create table b (id int);")],
      [row("20261001000000", sqlA)]
    );
    expect(plan.errors).toEqual([]);
    expect(plan.newMigrations.map((m) => m.version)).toEqual(["20261002000000"]);
    expect(plan.unchanged).toBe(1);
  });

  it("is a no-op when everything is already registered", () => {
    const sql = "create table a (id int);";
    const plan = planRegistration([file("20261001000000", sql)], [row("20261001000000", sql)]);
    expect(plan).toMatchObject({ newMigrations: [], unchanged: 1, errors: [] });
  });

  it("refuses a registered migration that was edited", () => {
    const plan = planRegistration(
      [file("20261001000000", "create table a (id int, extra int);")],
      [row("20261001000000", "create table a (id int);")]
    );
    expect(plan.errors.join()).toMatch(/was changed after it was registered/);
  });

  it("does not mistake Windows line endings for an edit", () => {
    const sql = "create table a (\n id int\n);\n";
    const plan = planRegistration(
      [file("20261001000000", sql.replace(/\n/g, "\r\n"))],
      [row("20261001000000", sql)]
    );
    expect(plan.errors).toEqual([]);
  });

  it("refuses when a registered migration has gone from the folder", () => {
    const plan = planRegistration(
      [file("20261002000000", "create table b (id int);")],
      [row("20261001000000", "create table a (id int);")]
    );
    expect(plan.errors.join()).toMatch(/registered but no longer in the folder/);
  });

  it("refuses a new migration that sorts before the newest registered one", () => {
    const sqlB = "create table b (id int);";
    const plan = planRegistration(
      [file("20261001000000", "create table a (id int);"), file("20261005000000", sqlB)],
      [row("20261005000000", sqlB)]
    );
    expect(plan.errors.join()).toMatch(
      /not newer than the newest registered migration \(20261005000000\)/
    );
  });

  it("reports every bad file, not just the first", () => {
    const plan = planRegistration(
      [
        file("20261001000000", ""),
        { name: "bad-name.sql", content: "select 1;" },
        file("20261003000000", "drop table x;"),
      ],
      []
    );
    expect(plan.errors).toHaveLength(3);
  });

  it("lints new files but not baseline ones", () => {
    const files = [
      file("20261001000000", "drop table old_thing;"),
      file("20261002000000", "drop table another;"),
    ];
    const plan = planRegistration(files, [], { baseline: "20261001000000" });
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0]).toMatch(/20261002000000.*drops a table/);
    expect(plan.newMigrations.map((m) => m.version)).toEqual(["20261001000000"]);
  });

  it("registers in version order whatever order the folder lists them", () => {
    const plan = planRegistration(
      [
        file("20261003000000", "select 3;"),
        file("20261001000000", "select 1;"),
        file("20261002000000", "select 2;"),
      ],
      []
    );
    expect(plan.newMigrations.map((m) => m.version)).toEqual([
      "20261001000000",
      "20261002000000",
      "20261003000000",
    ]);
  });
});
