import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { ROOT } from "./config.js";

const run = promisify(execFile);

export class SandboxError extends Error {}

/**
 * Tools the agent may use. Reviewing is a read-only activity, so nothing here
 * can modify the checkout, and the container holds no GitHub credential to
 * modify anything outside it.
 */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(git:*)"];

/**
 * Only reachable with ALLOW_TEST_EXECUTION=true. This is safe *because* of the
 * sandbox: the container has no GitHub token, no cloud credentials and no host
 * filesystem access, which is exactly the condition the review spec requires
 * before pull request code may be executed.
 */
const NODE_TOOLS = [
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(pnpm:*)",
  "Bash(yarn:*)",
  "Bash(bun:*)",
  "Bash(bunx:*)",
  "Bash(node:*)",
];

export async function assertDockerReady() {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 15_000,
    });
  } catch {
    throw new SandboxError(
      "Docker is not running. Start Docker Desktop (or your daemon) and try again."
    );
  }
}

export async function ensureImage(image, { onBuild } = {}) {
  try {
    await run("docker", ["image", "inspect", image], { timeout: 20_000 });
    return { built: false };
  } catch {
    onBuild?.(image);
    try {
      await run("docker", ["build", "--tag", image, ROOT], {
        timeout: 20 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (cause) {
      throw new SandboxError(
        `Could not build ${image}: ${(cause.stderr || cause.message).slice(-2000)}`
      );
    }
    return { built: true };
  }
}

/**
 * Runs the agent over the prepared workspace and returns its stdout.
 *
 * The container gets exactly one credential — the Claude token — and one
 * mount. It has network access because the model API requires it; the
 * protection here is not isolation from the internet but isolation from
 * anything that could act on GitHub or on this machine.
 */
export function runAgent({ workspace, config, allowExecution, onLog }) {
  const tools = allowExecution
    ? [...READ_ONLY_TOOLS, ...NODE_TOOLS]
    : READ_ONLY_TOOLS;

  const args = [
    "run",
    "--rm",
    "--interactive=false",
    `--memory=${config.memory}`,
    `--cpus=${config.cpus}`,
    // A review needs no elevated capability, and a compromised agent should
    // not be able to reach for one.
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    // Fork bombs from a malicious postinstall script stay contained.
    "--pids-limit=512",
    // The workspace is mounted read-write because git needs a writable index,
    // and because the host reads nothing back from it except stdout.
    "--volume",
    `${workspace.root}:/work`,
    // cwd is deliberately NOT the repository: Claude Code auto-discovers
    // CLAUDE.md upward from cwd, and a CLAUDE.md added by the pull request
    // must never become instructions for the agent reviewing it.
    "--workdir",
    "/work/review",
    "--env",
    "DISABLE_AUTOUPDATER=1",
    "--env",
    "DISABLE_TELEMETRY=1",
    "--env",
    "CI=1",
  ];

  if (config.claudeToken) {
    args.push("--env", `CLAUDE_CODE_OAUTH_TOKEN=${config.claudeToken}`);
  } else {
    args.push("--env", `ANTHROPIC_API_KEY=${config.anthropicKey}`);
  }

  // Assembled inside the container so the spec, schema and task are read from
  // files rather than squeezed through argv. The script is a fixed literal —
  // no pull request data is interpolated into it — and the only variable part
  // is the tool list, which this module owns.
  const script = [
    "exec claude",
    "--print",
    "--output-format json",
    `--model ${shellQuote(config.model)}`,
    `--max-turns ${config.maxTurns}`,
    "--add-dir /work/repo",
    `--allowedTools ${shellQuote(tools.join(","))}`,
    // Safe here and nowhere else: no credentials, no host mounts, disposable.
    "--permission-mode bypassPermissions",
    // Structured output is validated by the CLI, so the host is not left
    // scraping a JSON object out of prose.
    '--json-schema "$(cat /work/review/schema.json)"',
    '--append-system-prompt "$(cat /work/review/spec.md)"',
    '"$(cat /work/review/task.md)"',
  ].join(" ");

  args.push(config.image, "sh", "-c", script);

  return execute(args, config.timeoutMs, onLog);
}

/** POSIX single-quote escaping, for the few operator-supplied values above. */
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function execute(args, timeoutMs, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      onLog?.(text);
    });

    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(new SandboxError(`Could not start docker: ${cause.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new SandboxError(
            `The agent exceeded ${Math.round(timeoutMs / 1000)}s and was stopped. Raise CONTAINER_TIMEOUT_MS or narrow the review.`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new SandboxError(
            `The agent exited with code ${code}.\n${stderr.trim().slice(-2000) || "(no stderr)"}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
