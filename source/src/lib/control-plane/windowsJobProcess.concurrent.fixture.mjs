import { readFile, writeFile } from "node:fs/promises";
import { recoverWindowsJobProcess } from "./windowsJobProcess.ts";

const [descriptorPath, barrierPath, readyPath] = process.argv.slice(2);
if (!descriptorPath || !barrierPath || !readyPath) {
  throw new Error("Expected descriptorPath, barrierPath, and readyPath.");
}

await writeFile(readyPath, JSON.stringify({ pid: process.pid }), { encoding: "utf8", flag: "wx" });
for (;;) {
  try {
    await readFile(barrierPath);
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const recovered = await recoverWindowsJobProcess(descriptorPath);
const terminal = await recovered.cancel(250);
const evidence = await recovered.authenticatedStatusEvidence();
process.stdout.write(JSON.stringify({ pid: process.pid, terminal, evidence }));
