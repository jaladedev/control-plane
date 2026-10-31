import { z } from "zod";

// Where the worker gets school credentials. The interface is the point: today
// the values come from the worker's own environment; the plan puts them in
// Infisical, and swapping that in means writing one more class, nothing else.
// The dashboard web app never uses this module: it only queues jobs.

export interface SecretsProvider {
  schoolDatabaseUrl(slug: string): Promise<string>;
  /** The settings for a school's container (its project, bucket and keys), or undefined. */
  schoolAppEnv(slug: string): Promise<Record<string, string> | undefined>;
  /** Replaces anything secret in a message so it can be stored or logged. */
  redact(text: string): string;
}

const urlsSchema = z.record(z.string(), z.string().min(1));
const appEnvsSchema = z.record(z.string(), z.record(z.string(), z.string()));

export class EnvSecrets implements SecretsProvider {
  private readonly urls: Record<string, string>;
  private readonly appEnvs: Record<string, Record<string, string>>;

  constructor(raw: string | undefined, rawAppEnvs?: string) {
    if (!raw) throw new Error("SCHOOL_DB_URLS is not set in the worker's environment.");
    try {
      this.urls = urlsSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error('SCHOOL_DB_URLS must be JSON like {"slug":"postgres://..."}.');
    }
    try {
      this.appEnvs = rawAppEnvs ? appEnvsSchema.parse(JSON.parse(rawAppEnvs)) : {};
    } catch {
      throw new Error('SCHOOL_APP_ENVS must be JSON like {"slug":{"SUPABASE_URL":"https://..."}}.');
    }
  }

  async schoolAppEnv(slug: string) {
    return this.appEnvs[slug];
  }

  async schoolDatabaseUrl(slug: string): Promise<string> {
    const url = this.urls[slug];
    if (!url) throw new Error(`No database URL for "${slug}" in SCHOOL_DB_URLS.`);
    return url;
  }

  redact(text: string): string {
    let out = text;
    // Every value in a school's container settings is treated as secret, longest
    // first so a value that contains another is replaced whole.
    const values = Object.values(this.appEnvs)
      .flatMap((env) => Object.values(env))
      .filter((v) => v.length >= 8)
      .sort((a, b) => b.length - a.length);
    for (const value of values) out = out.split(value).join("[secret]");
    for (const url of Object.values(this.urls)) {
      out = out.split(url).join("[database url]");
      try {
        const password = decodeURIComponent(new URL(url).password);
        if (password.length >= 6) out = out.split(password).join("[secret]");
      } catch {
        // not a parseable URL: the whole-value replacement above is all we can do
      }
    }
    return out;
  }
}
