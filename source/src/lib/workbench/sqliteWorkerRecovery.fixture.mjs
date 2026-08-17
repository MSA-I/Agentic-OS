import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const [databasePath, executionId] = process.argv.slice(2);
if (!databasePath || !executionId) throw new Error("databasePath and executionId are required.");
const { SqliteDurableWorkerRepository } = await import("./sqliteWorkerRepository.ts");
const repository = new SqliteDurableWorkerRepository(databasePath);
try {
  const recovery = await repository.loadExecutionRecovery(executionId);
  const result = recovery?.recoveryAction === "terminal_replay"
    ? { action: "terminal_replay", spawnCount: 0, recovery }
    : { action: "fail_closed", spawnCount: 0, recovery };
  process.stdout.write(JSON.stringify(result));
} finally {
  repository.close();
}
