import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Creates and removes a login in a school's own Supabase Auth, with that
// school's service role key (from its container settings). Used once, to make
// the school's first admin. The key never leaves the worker.

export type AuthAdminConfig = { url: string; serviceRoleKey: string };
export type CreatedUser = { ok: true; id: string } | { ok: false; error: string };

export interface AuthAdmin {
  createUser(
    cfg: AuthAdminConfig,
    input: { email: string; password: string }
  ): Promise<CreatedUser>;
  deleteUser(cfg: AuthAdminConfig, id: string): Promise<void>;
}

const client = (cfg: AuthAdminConfig) =>
  createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export const supabaseAuthAdmin: AuthAdmin = {
  async createUser(cfg, { email, password }) {
    const { data, error } = await client(cfg).auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) return { ok: false, error: error?.message ?? "no user returned" };
    return { ok: true, id: data.user.id };
  },
  async deleteUser(cfg, id) {
    const { error } = await client(cfg).auth.admin.deleteUser(id);
    if (error) throw new Error(error.message);
  },
};

const WORDS = [
  "acorn",
  "amber",
  "atlas",
  "basil",
  "birch",
  "cedar",
  "cobalt",
  "coral",
  "daisy",
  "delta",
  "ember",
  "fern",
  "glade",
  "harbor",
  "honey",
  "ivory",
  "juniper",
  "lagoon",
  "lumen",
  "maple",
  "marble",
  "meadow",
  "noble",
  "ocean",
  "olive",
  "orchid",
  "pearl",
  "pine",
  "quartz",
  "river",
  "rose",
  "sable",
  "spruce",
  "stone",
  "tulip",
  "willow",
  "zenith",
];

/** Four words and a number, like the school app's own temporary passwords. The login makes the admin change it. */
export function temporaryPassword(): string {
  const words = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]);
  return `${words.join("-")}-${randomInt(100, 999)}`;
}
