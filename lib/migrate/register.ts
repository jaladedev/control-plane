import { MigrationFileError, parseMigration, type ParsedMigration } from "@/lib/migrate/parse";

// Deciding what registering a release would do, from the migration files on
// disk and what is already registered. Pure; the CLI does the reading and
// writing. Registered migrations are history, so the rules are strict:
//   - a file already registered must be byte-for-byte what was registered
//   - a registered migration must still be in the folder
//   - new migrations must sort after everything registered

export type RegisteredRow = { version: string; name: string; checksum: string };

export type RegistrationPlan = {
  newMigrations: ParsedMigration[];
  unchanged: number;
  errors: string[];
};

export function planRegistration(
  files: { name: string; content: string }[],
  registered: RegisteredRow[],
  opts: { baseline?: string } = {}
): RegistrationPlan {
  const errors: string[] = [];
  const parsed: ParsedMigration[] = [];

  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const version = f.name.slice(0, 14);
    const isBaseline = opts.baseline !== undefined && version <= opts.baseline;
    try {
      parsed.push(parseMigration(f.name, f.content, { baseline: isBaseline }));
    } catch (e) {
      errors.push(
        e instanceof MigrationFileError ? e.message : `${f.name}: ${(e as Error).message}`
      );
    }
  }

  const byVersion = new Map(registered.map((r) => [r.version, r]));
  const present = new Set(parsed.map((p) => p.version));
  for (const r of registered) {
    if (!present.has(r.version) && !errors.some((e) => e.startsWith(r.name))) {
      errors.push(
        `${r.name} is registered but no longer in the folder. The folder must hold the whole history.`
      );
    }
  }

  const newMigrations: ParsedMigration[] = [];
  let unchanged = 0;
  for (const p of parsed) {
    const existing = byVersion.get(p.version);
    if (!existing) newMigrations.push(p);
    else if (existing.checksum !== p.checksum) {
      errors.push(
        `${p.name} was changed after it was registered. A registered migration is never edited: add a new one instead.`
      );
    } else unchanged++;
  }

  const newest = registered
    .map((r) => r.version)
    .sort()
    .at(-1);
  if (newest) {
    for (const m of newMigrations) {
      if (m.version <= newest) {
        errors.push(
          `${m.name} is not newer than the newest registered migration (${newest}); new migrations must sort after it.`
        );
      }
    }
  }
  return { newMigrations, unchanged, errors };
}
