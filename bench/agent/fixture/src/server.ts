import { createServer } from "node:http";
import { Router } from "./routes/router.ts";
import { registerTaskRoutes } from "./routes/tasks.ts";
import { TaskStore } from "./store/taskStore.ts";

export function buildApp(store = new TaskStore()) {
  const router = new Router();
  registerTaskRoutes(router, store);
  return { router, store };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { router } = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  createServer(router.listener()).listen(port, "127.0.0.1", () => {
    console.log(`taskboard listening on http://127.0.0.1:${port}`);
  });
}
