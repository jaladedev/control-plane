import { describe, expect, it, vi } from "vitest";
import { fetchMigrationsAtCommit } from "@/lib/github-migrations";

const SHA = "a".repeat(40);
const base = `https://api.github.com/repos/o/r/contents/`;

function fakeFetch(files: Record<string, string>, listing?: unknown) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/contents/supabase/migrations?ref=")) {
      return new Response(
        JSON.stringify(
          listing ??
            Object.keys(files).map((name) => ({
              name,
              type: "file",
              url: `${base}supabase/migrations/${name}?ref=${SHA}`,
            }))
        )
      );
    }
    const name = decodeURIComponent(u.split("/").pop()!.split("?")[0]);
    return name in files ? new Response(files[name]) : new Response("no", { status: 404 });
  });
}

describe("fetchMigrationsAtCommit", () => {
  it("lists the folder at the commit and reads each .sql file, sending the token", async () => {
    const f = fakeFetch({ "20261001000000_a.sql": "select 1", "README.md": "ignored" }, [
      {
        name: "20261001000000_a.sql",
        type: "file",
        url: `${base}supabase/migrations/20261001000000_a.sql?ref=${SHA}`,
      },
      { name: "README.md", type: "file", url: `${base}supabase/migrations/README.md?ref=${SHA}` },
      { name: "sub", type: "dir", url: `${base}supabase/migrations/sub?ref=${SHA}` },
    ]);
    const files = await fetchMigrationsAtCommit({
      repo: "o/r",
      sha: SHA,
      token: "tok",
      fetchImpl: f as never,
    });
    expect(files).toEqual([{ name: "20261001000000_a.sql", content: "select 1" }]);
    expect(String(f.mock.calls[0][0])).toContain(`ref=${SHA}`);
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok",
    });
  });

  it("refuses a bad repo or commit before any request", async () => {
    const f = vi.fn();
    await expect(
      fetchMigrationsAtCommit({ repo: "o/r/../x", sha: SHA, token: "t", fetchImpl: f as never })
    ).rejects.toThrow(/owner\/name/);
    await expect(
      fetchMigrationsAtCommit({ repo: "o/r", sha: "main", token: "t", fetchImpl: f as never })
    ).rejects.toThrow(/40-character/);
    expect(f).not.toHaveBeenCalled();
  });

  it("will not follow a file link that leaves the repository's contents endpoint", async () => {
    const f = fakeFetch({}, [
      { name: "20261001000000_a.sql", type: "file", url: "https://evil.example/x" },
    ]);
    await expect(
      fetchMigrationsAtCommit({ repo: "o/r", sha: SHA, token: "t", fetchImpl: f as never })
    ).rejects.toThrow(/Unexpected link/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("reports GitHub errors without including the token", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 404 }));
    const err = await fetchMigrationsAtCommit({
      repo: "o/r",
      sha: SHA,
      token: "secret-token",
      fetchImpl: f as never,
    }).catch((e) => e);
    expect(String(err.message)).toMatch(/404/);
    expect(String(err.message)).not.toContain("secret-token");
  });
});
