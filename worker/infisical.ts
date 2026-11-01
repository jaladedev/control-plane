import { z } from "zod";
import { redactSecretText, type SecretsProvider } from "@/worker/secrets";

// School credentials from Infisical instead of the worker's own environment. Each school
// has one folder, `<basePath>/<slug>` (default `/schools/greenfield`), holding:
//
//   DATABASE_URL   its direct Postgres connection string
//   <anything else> the settings its container starts with (SUPABASE_URL, R2_*, ...)
//
// The worker signs in as a machine identity (Universal Auth) and reads every school's
// folder in one recursive request. The result is cached for a short time, so a rotated
// secret takes effect without a restart. redact() is synchronous and is called from
// everywhere, so it scrubs from what has been loaded, including values seen earlier in
// this process that have since been rotated away.

export const DATABASE_URL_KEY = "DATABASE_URL";

export type InfisicalConfig = {
  /** For example https://app.infisical.com, https://eu.infisical.com or your own host. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  /** The folder that holds one sub-folder per school. */
  basePath: string;
  /** How long a read stays good. */
  cacheMs: number;
  /** If Infisical cannot be reached, how long the last good read may still be used. */
  maxStaleMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const TIMEOUT_MS = 15_000;
const DEFAULT_MAX_STALE_MS = 15 * 60_000;

const loginSchema = z.object({ accessToken: z.string().min(1), expiresIn: z.number() });
const secretsSchema = z.object({
  secrets: z.array(
    z.object({
      secretKey: z.string(),
      secretValue: z.string(),
      // Optional in Infisical's schema; a read without it is refused, see load().
      secretPath: z.string().optional(),
    })
  ),
});

type School = { url?: string; env: Record<string, string> };
type Snapshot = { at: number; schools: Map<string, School> };

export class InfisicalSecrets implements SecretsProvider {
  private snapshot: Snapshot | null = null;
  private refreshing: Promise<Snapshot> | null = null;
  private token: { value: string; expiresAt: number } | null = null;
  // Everything ever loaded in this process, so a value rotated away is still scrubbed
  // from a message that was already on its way.
  private readonly seenValues = new Set<string>();
  private readonly seenUrls = new Set<string>();
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private constructor(private readonly cfg: InfisicalConfig) {
    const url = new URL(cfg.baseUrl);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("INFISICAL_URL must be https.");
    }
    this.base = cfg.basePath.replace(/\/+$/, "") || "";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  /** Signs in and reads once, so a worker with wrong credentials stops at start-up. */
  static async create(cfg: InfisicalConfig): Promise<InfisicalSecrets> {
    const provider = new InfisicalSecrets(cfg);
    await provider.fresh();
    return provider;
  }

  async schoolDatabaseUrl(slug: string): Promise<string> {
    const url = (await this.fresh()).schools.get(slug)?.url;
    if (!url) {
      throw new Error(
        `No database URL for "${slug}" in Infisical (${this.base}/${slug}/${DATABASE_URL_KEY}).`
      );
    }
    return url;
  }

  async schoolAppEnv(slug: string): Promise<Record<string, string> | undefined> {
    const env = (await this.fresh()).schools.get(slug)?.env;
    return env && Object.keys(env).length > 0 ? { ...env } : undefined;
  }

  redact(text: string): string {
    return redactSecretText(text, { appEnvValues: this.seenValues, databaseUrls: this.seenUrls });
  }

  private async fresh(): Promise<Snapshot> {
    const started = this.now();
    if (this.snapshot && started - this.snapshot.at < this.cfg.cacheMs) return this.snapshot;
    // One read at a time: callers that arrive while one is running share it.
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = null;
    });
    try {
      return await this.refreshing;
    } catch (error) {
      const maxStale = this.cfg.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
      if (this.snapshot && started - this.snapshot.at < maxStale) return this.snapshot;
      throw error;
    }
  }

  private async load(): Promise<Snapshot> {
    const token = await this.accessToken();
    const query = new URLSearchParams({
      projectId: this.cfg.projectId,
      environment: this.cfg.environment,
      secretPath: this.base || "/",
      recursive: "true",
      includeImports: "false",
      expandSecretReferences: "false",
    });
    const body = await this.request(`/api/v4/secrets?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const parsed = secretsSchema.safeParse(body);
    if (!parsed.success)
      throw new Error("Infisical answered with something unexpected when reading secrets.");

    const schools = new Map<string, School>();
    const prefix = `${this.base}/`;
    for (const s of parsed.data.secrets) {
      // Without the folder there is no telling whose secret it is: refuse the whole read
      // rather than guess.
      if (s.secretPath === undefined) {
        throw new Error(
          "Infisical did not say which folder a secret is in, so none of them can be used."
        );
      }
      const path = s.secretPath.replace(/\/+$/, "");
      if (!path.startsWith(prefix)) continue;
      const slug = path.slice(prefix.length);
      if (!SLUG.test(slug)) continue; // the base folder itself, or a deeper folder
      const school = schools.get(slug) ?? { env: {} };
      if (s.secretKey === DATABASE_URL_KEY) school.url = s.secretValue;
      else school.env[s.secretKey] = s.secretValue;
      schools.set(slug, school);
    }

    for (const school of schools.values()) {
      if (school.url) this.seenUrls.add(school.url);
      for (const value of Object.values(school.env)) this.seenValues.add(value);
    }
    this.snapshot = { at: this.now(), schools };
    return this.snapshot;
  }

  private async accessToken(): Promise<string> {
    // Sign in again a little before the token ends.
    if (this.token && this.now() < this.token.expiresAt - 30_000) return this.token.value;
    const body = await this.request("/api/v1/auth/universal-auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }),
    });
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success)
      throw new Error("Infisical answered with something unexpected when signing in.");
    this.token = {
      value: parsed.data.accessToken,
      expiresAt: this.now() + parsed.data.expiresIn * 1000,
    };
    return this.token.value;
  }

  /** One request. Nothing in an error ever contains a credential or a secret value. */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.cfg.baseUrl), {
        ...init,
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      throw new Error("Infisical could not be reached.");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const what = path.startsWith("/api/v1/auth") ? "signing in" : "reading secrets";
      const hint =
        res.status === 401 || res.status === 403
          ? " Check the machine identity's client ID and secret, and that it can read the school folders."
          : "";
      throw new Error(`Infisical answered ${res.status} when ${what}.${hint}`);
    }
    return res.json().catch(() => null);
  }
}
