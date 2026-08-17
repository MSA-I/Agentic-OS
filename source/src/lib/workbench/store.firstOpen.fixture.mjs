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

const [databasePath, barrierPath] = process.argv.slice(2);
if (!databasePath || !barrierPath) process.exit(64);

const started = Date.now();
while (!existsSync(barrierPath)) {
  if (Date.now() - started > 10_000) process.exit(70);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const { WorkbenchStore } = await import("./store.ts");
const store = new WorkbenchStore(databasePath);
try {
  process.stdout.write(JSON.stringify({
    schemaVersion: store.storageConfiguration().schemaVersion,
    ledger: store.migrationLedger().map(({ version, checksumSha256 }) => ({ version, checksumSha256 })),
  }));
} finally {
  store.close();
}
