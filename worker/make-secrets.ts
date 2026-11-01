import { z } from "zod";
import { backendProblems, infisicalShape } from "@/worker/env";
import { InfisicalSecrets } from "@/worker/infisical";
import { EnvSecrets, type SecretsProvider } from "@/worker/secrets";

type Settings = {
  SCHOOL_DB_URLS?: string;
  SCHOOL_APP_ENVS?: string;
} & Partial<z.infer<z.ZodObject<typeof infisicalShape>>>;

/**
 * Infisical when its credentials are set, otherwise the environment. Reads once up front,
 * so wrong credentials stop a start instead of failing the first job.
 */
export async function makeSecrets(s: Settings): Promise<SecretsProvider> {
  if (!s.INFISICAL_CLIENT_ID) return new EnvSecrets(s.SCHOOL_DB_URLS, s.SCHOOL_APP_ENVS);
  const url = s.INFISICAL_URL ?? infisicalShape.INFISICAL_URL.parse(undefined);
  return InfisicalSecrets.create({
    baseUrl: url,
    clientId: s.INFISICAL_CLIENT_ID,
    clientSecret: s.INFISICAL_CLIENT_SECRET!,
    projectId: s.INFISICAL_PROJECT_ID!,
    environment: s.INFISICAL_ENVIRONMENT ?? infisicalShape.INFISICAL_ENVIRONMENT.parse(undefined),
    basePath: s.INFISICAL_SECRETS_PATH ?? infisicalShape.INFISICAL_SECRETS_PATH.parse(undefined),
    cacheMs:
      (s.INFISICAL_CACHE_SECONDS ?? infisicalShape.INFISICAL_CACHE_SECONDS.parse(undefined)) * 1000,
  });
}

/** For scripts that run outside the worker: the same choice, from the process environment. */
export async function secretsFromProcessEnv(
  source: Record<string, string | undefined> = process.env
): Promise<SecretsProvider> {
  const problems = backendProblems(source);
  if (problems.length > 0)
    throw new Error(`Where the school credentials come from:\n  ${problems.join("\n  ")}`);
  return makeSecrets(
    z
      .object(infisicalShape)
      .partial()
      .extend({
        SCHOOL_DB_URLS: z.string().optional(),
        SCHOOL_APP_ENVS: z.string().optional(),
      })
      .parse(source)
  );
}
