// The three fixed roles (plan section 2). Built from day one, even with a
// single user, so no action is ever written without saying who may do it.
export const ROLES = ["owner", "finance", "support"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  finance: "Finance",
  support: "Support",
};
