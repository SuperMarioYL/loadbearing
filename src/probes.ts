import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_SCHEMA = "loadbearing/config@1";

/** One oracle: a shell command plus the file globs whose changes it observes. */
export type Probe = {
  name: string;
  run: string;
  paths: string[];
};

export type LoadedConfig = {
  schema: typeof CONFIG_SCHEMA;
  probes: Probe[];
  /** Shell command run once per worktree before probes (e.g. `npm ci`). */
  setup?: string;
  /** Per-probe timeout in milliseconds. */
  timeoutMs: number;
  path: string;
};

export class ConfigError extends Error {}

const CONFIG_FILES = ["loadbearing.yml", "loadbearing.yaml"] as const;
const DEFAULT_TIMEOUT_SECONDS = 120;

const ProbeSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});

const ConfigSchema = z.object({
  schema: z.literal(CONFIG_SCHEMA).optional(),
  probes: z.array(ProbeSchema).default([]),
  sandbox: z.object({ setup: z.string().min(1).optional() }).optional(),
  timeout: z.number().int().positive().optional(),
});

/**
 * Load and validate the probe config. An explicit path is resolved against the
 * repo root; otherwise the first of loadbearing.yml / loadbearing.yaml wins.
 */
export function loadConfig(root: string, explicitPath?: string): LoadedConfig {
  const path = explicitPath === undefined ? findConfig(root) : resolve(root, explicitPath);
  if (path === undefined) {
    throw new ConfigError(`no loadbearing.yml found in ${root}; run \`loadbearing init\` or add one`);
  }
  if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`cannot parse ${path}: ${messageOf(error)}`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigError(`invalid config ${path}: ${issues.join("; ")}`);
  }

  const probes = parsed.data.probes;
  const seen = new Set<string>();
  for (const probe of probes) {
    if (seen.has(probe.name)) throw new ConfigError(`duplicate probe name "${probe.name}" in ${path}`);
    seen.add(probe.name);
    try {
      picomatch(probe.paths);
    } catch (error) {
      throw new ConfigError(`invalid glob for probe "${probe.name}": ${messageOf(error)}`);
    }
  }

  return {
    schema: CONFIG_SCHEMA,
    probes,
    setup: parsed.data.sandbox?.setup,
    timeoutMs: (parsed.data.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    path,
  };
}

/** Probes with at least one glob matching one of the cluster's files. */
export function probesForFiles(probes: readonly Probe[], files: readonly string[]): Probe[] {
  return probes.filter((probe) => {
    const matches = picomatch(probe.paths, { dot: true });
    return files.some((file) => matches(file));
  });
}

export type CommandRun = {
  name: string;
  run: string;
  /** null when the command timed out, died on a signal, or never started. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last 20 lines of combined stdout/stderr. */
  tail: string[];
  error?: string;
};

/** A probe passed: exit 0, no timeout, no harness error. */
export function passed(run: CommandRun): boolean {
  return run.exitCode === 0 && !run.timedOut && run.error === undefined;
}

/** The command ran and reported a non-zero status (positive evidence of a regression). */
export function failed(run: CommandRun): boolean {
  return run.exitCode !== null && run.exitCode !== 0 && !run.timedOut && run.error === undefined;
}

/** The harness could not obtain an exit status: timeout, signal, spawn failure. */
export function harnessError(run: CommandRun): boolean {
  return !passed(run) && !failed(run);
}

/** Run one shell command in `cwd`, capturing its last 20 lines of output. */
export async function runCommand(
  name: string,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandRun> {
  return await new Promise<CommandRun>((resolvePromise) => {
    const started = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      shell: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const capture = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      // Keep the buffer bounded; only the tail is reported.
      if (output.length > 256 * 1024) output = output.slice(-128 * 1024);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, detached);
    }, timeoutMs);

    let settled = false;
    const finish = (run: CommandRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(run);
    };

    child.on("error", (error) => {
      finish({
        name,
        run: command,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - started,
        tail: tailLines(output),
        error: error.message,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        name,
        run: command,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        tail: tailLines(output),
        error: timedOut
          ? `timed out after ${timeoutMs} ms`
          : code === null && signal !== null
            ? `terminated by ${signal}`
            : undefined,
      });
    });
  });
}

export function runProbe(probe: Probe, cwd: string, timeoutMs: number): Promise<CommandRun> {
  return runCommand(probe.name, probe.run, cwd, timeoutMs);
}

function findConfig(root: string): string | undefined {
  for (const name of CONFIG_FILES) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function tailLines(text: string, limit = 20): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-limit);
}

function killTree(child: { pid?: number; kill: (signal: NodeJS.Signals) => boolean }, detached: boolean): void {
  if (detached && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to a plain kill.
    }
  }
  child.kill("SIGKILL");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
