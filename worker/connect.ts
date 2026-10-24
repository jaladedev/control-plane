import { readFileSync } from "node:fs";
import { Client } from "pg";
import type { SchoolConnection } from "@/worker/handlers";

// One short-lived connection per job, straight to the school's database (the
// direct connection: migrations need a session, not a pooler).

export function sslOptions(databaseUrl: string, caFile?: string) {
  const host = new URL(databaseUrl).hostname;
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return undefined;
  if (caFile) return { ca: readFileSync(caFile, "utf8"), rejectUnauthorized: true };
  // Encrypted but not verified: Supabase's CA is not in Node's trust store.
  // Set SCHOOL_DB_CA_FILE to the project's CA certificate to verify it.
  return { rejectUnauthorized: false };
}

export function makeConnect(caFile?: string) {
  return async (databaseUrl: string): Promise<SchoolConnection> => {
    const client = new Client({
      connectionString: databaseUrl,
      ssl: sslOptions(databaseUrl, caFile),
      connectionTimeoutMillis: 15_000,
      application_name: "control-plane-worker",
    });
    await client.connect();
    return { db: client, close: () => client.end() };
  };
}
