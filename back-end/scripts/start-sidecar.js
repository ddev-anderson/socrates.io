import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "..");
const appDir = path.resolve(backendDir, "..");
const serverVozDir = path.join(appDir, "server-voz");

function fail(message) {
  console.error(`[socrates-tts] ${message}`);
  process.exit(1);
}

const projectDir = process.env.MLX_PROJECT_DIR?.trim();
if (!projectDir) {
  fail(
    "defina MLX_PROJECT_DIR no .env (caminho do checkout qwen3-tts-apple-silicon)",
  );
}

const uvicorn = path.join(projectDir, ".venv", "bin", "uvicorn");
if (!existsSync(uvicorn)) {
  fail(`uvicorn não encontrado em ${uvicorn}`);
}

if (!existsSync(path.join(serverVozDir, "app.py"))) {
  fail(`server-voz/app.py não encontrado em ${serverVozDir}`);
}

const host = process.env.MLX_HOST?.trim() || "0.0.0.0";
const port = process.env.MLX_PORT?.trim() || "8880";

console.log(
  `[socrates-tts] iniciando sidecar em http://${host}:${port} (Ctrl+C para parar)`,
);

const child = spawn(uvicorn, ["app:app", "--host", host, "--port", port], {
  cwd: serverVozDir,
  stdio: "inherit",
  env: { ...process.env, MLX_PROJECT_DIR: projectDir },
});

child.on("error", (error) => {
  fail(`falha ao iniciar o uvicorn: ${error.message}`);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
