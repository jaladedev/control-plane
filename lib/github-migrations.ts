// Reads a commit's supabase/migrations folder from GitHub, so a release can be
// registered from just its commit hash. The token needs read access to the
// school app repository's contents and nothing else.

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_FILES = 1000;

type Entry = { name: string; type: string; url: string };

export async function fetchMigrationsAtCommit(opts: {
  repo: string;
  sha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ name: string; content: string }[]> {
  const { repo, sha, token } = opts;
  const f = opts.fetchImpl ?? fetch;
  if (!REPO.test(repo)) throw new Error("The school app repository must look like owner/name.");
  if (!COMMIT.test(sha)) throw new Error("A release is a full 40-character commit hash.");

  const get = async (url: string, accept: string) => {
    const res = await f(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub answered ${res.status} for ${new URL(url).pathname}.`);
    }
    return res;
  };

  const listing = await get(
    `https://api.github.com/repos/${repo}/contents/supabase/migrations?ref=${sha}`,
    "application/vnd.github+json"
  );
  const entries = (await listing.json()) as Entry[];
  if (!Array.isArray(entries))
    throw new Error("supabase/migrations is not a folder at that commit.");

  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".sql"));
  if (files.length > MAX_FILES) throw new Error("Too many migration files to read.");

  const out: { name: string; content: string }[] = [];
  for (const entry of files) {
    // Only follow links that stay on this repository's contents endpoint.
    const expected = `https://api.github.com/repos/${repo}/contents/`;
    if (!entry.url.startsWith(expected)) throw new Error(`Unexpected link for ${entry.name}.`);
    const res = await get(entry.url, "application/vnd.github.raw+json");
    out.push({ name: entry.name, content: await res.text() });
  }
  return out;
}
