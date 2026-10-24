import { spawn } from "node:child_process";

// Runs the VPS deploy script (deploy/school-deploy) over SSH. The server side
// is a forced command: the key can run that one program and nothing else, so
// what this module sends is only ever "<action> <slug> [<tag>]". It still
// checks everything first, because the cheapest place to refuse bad input is
// before a process starts.

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const TAG = /^[0-9a-f]{40}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type DeployCommand =
  { action: "deploy"; slug: string; tag: string } | { action: "rollback" | "status"; slug: string };

export type DeployConfig = {
  host: string;
  user: string;
  keyFile: string;
  knownHostsFile: string;
  timeoutMs?: number;
  exec?: Exec;
};

export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Exec = (args: string[], timeoutMs: number) => Promise<ExecResult>;

export type DeployOutcome = {
  ok: boolean;
  code: number | null;
  status: string;
  tag: string;
  message: string;
};

// What each exit code of the script means (deploy/README.md).
const EXIT_MESSAGES: Record<number, string> = {
  2: "The deploy script refused the command (bad slug, tag or hostname).",
  3: "The school is unknown to the server, or there is no previous version.",
  10: "The new version was not healthy; the server rolled back to the old one.",
  11: "The new version was not healthy AND the rollback failed. Look at the server now.",
  12: "Another operation is already running for this school.",
  13: "The proxy would not load the route.",
  14: "Create failed and everything it made was removed.",
  15: "The image could not be pulled; nothing changed.",
};

export const sshExec: Exec = (args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-20_000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export function buildSshArgs(cfg: DeployConfig, command: string): string[] {
  for (const [name, value] of [
    ["host", cfg.host],
    ["user", cfg.user],
  ] as const) {
    if (!WORD.test(value)) throw new Error(`Deploy SSH ${name} looks wrong.`);
  }
  return [
    "-i",
    cfg.keyFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${cfg.knownHostsFile}`,
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    `${cfg.user}@${cfg.host}`,
    command,
  ];
}

export function commandLine(cmd: DeployCommand): string {
  if (!SLUG.test(cmd.slug)) throw new Error("Bad school slug.");
  if (cmd.action === "deploy") {
    if (!TAG.test(cmd.tag)) throw new Error("Tag must be a full 40-character commit hash.");
    return `deploy ${cmd.slug} ${cmd.tag}`;
  }
  if (cmd.action !== "rollback" && cmd.action !== "status")
    throw new Error("Unknown deploy action.");
  return `${cmd.action} ${cmd.slug}`;
}

function parseResult(stdout: string): { status: string; tag: string } | null {
  const line = stdout.trimEnd().split("\n").at(-1) ?? "";
  const m = line.match(/^RESULT (\{.*\})$/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return { status: String(parsed.status ?? ""), tag: String(parsed.tag ?? "") };
  } catch {
    return null;
  }
}

/** Never throws for a failed deploy; throws only for input that is refused before sending. */
export async function runDeployCommand(
  cfg: DeployConfig,
  cmd: DeployCommand
): Promise<DeployOutcome> {
  const args = buildSshArgs(cfg, commandLine(cmd));
  const timeoutMs = cfg.timeoutMs ?? 6 * 60_000;
  const res = await (cfg.exec ?? sshExec)(args, timeoutMs);

  if (res.timedOut) {
    return {
      ok: false,
      code: null,
      status: "timeout",
      tag: "",
      message: "The deploy did not finish in time. Check the server before retrying.",
    };
  }
  const result = parseResult(res.stdout);
  if (res.code === 0 && result && ["ok", "running", "stopped"].includes(result.status)) {
    return { ok: true, code: 0, status: result.status, tag: result.tag, message: "" };
  }
  const known = res.code !== null ? EXIT_MESSAGES[res.code] : undefined;
  const detail =
    known ??
    (res.code === 255
      ? "Could not connect to the server over SSH."
      : `The deploy script exited with code ${res.code}.`);
  const lastError = res.stderr.trim().split("\n").filter(Boolean).at(-1);
  return {
    ok: false,
    code: res.code,
    status: result?.status ?? "error",
    tag: result?.tag ?? "",
    message: lastError && !known ? `${detail} ${lastError.slice(0, 200)}` : detail,
  };
}
