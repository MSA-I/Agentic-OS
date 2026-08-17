import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
      const target = existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : existsSync(`${candidate}.ts`)
          ? `${candidate}.ts`
          : path.join(candidate, "index.ts");
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : existsSync(`${candidate}.ts`)
          ? `${candidate}.ts`
          : path.join(candidate, "index.ts");
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const [databasePath, inputPath, readyPath, barrierPath, delayText] = process.argv.slice(2);
if (!databasePath || !inputPath || !readyPath || !barrierPath) process.exit(64);
const delayMs = Number(delayText ?? 0);
if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) process.exit(64);

const input = JSON.parse(readFileSync(inputPath, "utf8"));
const { SqliteDurableWorkerRepository } = await import("./sqliteWorkerRepository.ts");
const repository = new SqliteDurableWorkerRepository(databasePath);
try {
  writeFileSync(readyPath, "ready", "utf8");
  const started = Date.now();
  while (!existsSync(barrierPath)) {
    if (Date.now() - started > 10_000) process.exit(70);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const result = await repository.completeCommand(input);
  process.stdout.write(JSON.stringify(result));
} finally {
  repository.close();
}
