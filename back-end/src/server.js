import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      frontendDir: config.frontendDir,
      ttsProvider: config.ttsProvider,
      deepseekKey: config.hasDeepSeekKey,
      liveChat: config.ready,
    },
    "socrates-backend pronto",
  );
} catch (error) {
  app.log.error(error, "falha ao iniciar o servidor");
  process.exit(1);
}

let closing = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "encerrando servidor");
    await app.close();
    process.exit(0);
  });
}
