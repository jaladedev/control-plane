// The steps of provisioning, in the order they run. Shared by the worker (which
// runs them) and the school page (which shows them); the database's CHECK on
// provision_steps.step lists the same names.
export const PROVISION_STEPS = [
  "database",
  "storage",
  "container",
  "license",
  "admin",
  "health",
  "activate",
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];
export type ProvisionStatus = "pending" | "running" | "succeeded" | "failed";
