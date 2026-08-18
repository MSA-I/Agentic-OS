import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    let candidate = null;
    if (specifier.startsWith("@/")) {
      candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      candidate = new URL(specifier, context.parentURL);
      candidate = decodeURIComponent(candidate.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
    }
    if (candidate) {
      for (const target of [`${candidate}.ts`, candidate, path.join(candidate, "index.ts")]) {
        if (existsSync(target) && statSync(target).isFile()) {
          return { shortCircuit: true, url: pathToFileURL(target).href };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const { checkCommand, ARGUMENT_PATTERN, ALLOWED_PROGRAMS } = await import("./commandPolicy.ts");
const { spawnInvocation } = await import("../setupRuntime.ts");

const ok = (program, args, timeout) => {
  const result = checkCommand(program, args, timeout);
  assert.ok(result.ok, `${program} ${args.join(" ")} → ${result.code}: ${result.reason}`);
};
const rejects = (code, program, args, timeout) => {
  const result = checkCommand(program, args, timeout);
  assert.equal(result.ok, false, `${program} ${args.join(" ")} was accepted`);
  assert.equal(result.code, code);
  assert.ok(result.reason.length > 0);
};

test("the real install commands the catalog already ships are accepted", () => {
  ok("npm", ["install", "-g", "opencode-ai@1.18.16"]);
  ok("npm", ["install", "-g", "omniroute@3.8.49"]);
  ok("npx", ["--yes", "playwright@1.51.1", "install", "chromium"]);
  ok("winget", ["install", "--id", "Ollama.Ollama"]);
  ok("py", ["-m", "pip", "install", "--user", "Pillow==12.3.0"]);
  ok("uv", ["tool", "install", "notebooklm-mcp-cli==0.9.8"]);
  ok("ollama", ["pull", "gemma2"]);
  ok("git", ["clone", "https://github.com/nexu-io/open-design"]);
  ok("git", ["clone", "https://github.com/nexu-io/open-design.git"]);
});

test("an interpreter is never a program, however it is spelled", () => {
  for (const program of ["cmd", "powershell", "pwsh", "bash", "sh", "node", "python", "curl", "msiexec", "reg"]) {
    rejects("program_not_allowed", program, ["-c", "whatever"]);
  }
  rejects("program_not_allowed", "npm.cmd", ["install"]);
  rejects("program_not_allowed", "C:\\Windows\\System32\\cmd.exe", []);
});

test("shell metacharacters cannot reach a command line", () => {
  for (const hostile of ["&&", "|", ";", ">", "<", "^", "%PATH%", "`whoami`", "$(id)", "a b", '"q"', "x\ny"]) {
    rejects("argument_characters", "npm", ["install", hostile]);
  }
});

test("a subcommand outside the program's own list is refused", () => {
  rejects("subcommand_not_allowed", "npm", ["run", "postinstall"]);
  rejects("subcommand_not_allowed", "npm", ["exec", "anything"]);
  rejects("subcommand_not_allowed", "git", ["checkout", "main"]);
  rejects("subcommand_not_allowed", "uv", ["run", "x"]);
  rejects("subcommand_not_allowed", "uv", ["tool", "run"]);
  rejects("subcommand_not_allowed", "py", ["-m", "http.server"]);
  rejects("subcommand_not_allowed", "npm", []);
});

test("git clone is the only place a URL is allowed, and only over https", () => {
  rejects("url_not_allowed", "npm", ["install", "https://example.com/pkg.tgz"]);
  rejects("git_url_invalid", "git", ["clone", "ssh://git@github.com/a/b"]);
  rejects("git_url_invalid", "git", ["clone", "git://github.com/a/b"]);
  rejects("git_url_invalid", "git", ["clone", "file:///c/secrets"]);
  rejects("git_url_invalid", "git", ["clone", "https://user:pw@github.com/a/b"]);
  rejects("git_url_invalid", "git", ["clone", "https://127.0.0.1/a/b"]);
  rejects("git_url_invalid", "git", ["clone", "https://localhost/a/b"]);
});

test("absolute paths are refused even when every character is legal", () => {
  rejects("absolute_path", "npm", ["install", "C:/tools/pkg"]);
  rejects("absolute_path", "npm", ["install", "/etc/passwd"]);
  rejects("absolute_path", "npm", ["install", "//share/pkg"]);
});

test("limits are enforced", () => {
  rejects("too_many_args", "npm", ["install", ...Array.from({ length: 30 }, (_, i) => `p${i}`)]);
  rejects("argument_too_long", "npm", ["install", "a".repeat(201)]);
  rejects("timeout_out_of_range", "npm", ["install", "x"], 5);
  rejects("timeout_out_of_range", "npm", ["install", "x"], 4000);
});

// The bug this prevents: spawnInvocation throws on an argument outside its own
// class when the executable is a .cmd wrapper, which every npm-installed CLI on
// Windows is. If the two classes ever drift, a plan passes review and then dies
// at spawn time with a 500 the user cannot act on.
test("every argument this policy accepts also survives spawnInvocation", () => {
  const corpus = [
    "install", "-g", "--yes", "--id", "-m", "--user", "clone",
    "opencode-ai@1.18.16", "Pillow==12.3.0", "Ollama.Ollama", "gemma2",
    "https://github.com/nexu-io/open-design.git", "a/b/c", "x_y.z", "v1.2.3+build",
    "a".repeat(200),
  ];
  for (const arg of corpus) {
    assert.ok(ARGUMENT_PATTERN.test(arg), `policy rejects its own corpus entry: ${arg}`);
    assert.doesNotThrow(
      () => spawnInvocation("C:\\Program Files\\nodejs\\npm.cmd", [arg]),
      `spawnInvocation rejects a policy-accepted argument: ${arg}`,
    );
  }
});

test("every allowed program is a package manager, not an interpreter", () => {
  const interpreters = ["node", "python", "python3", "sh", "bash", "cmd", "powershell", "pwsh", "perl", "ruby"];
  for (const program of Object.keys(ALLOWED_PROGRAMS)) {
    assert.ok(!interpreters.includes(program), `${program} is an interpreter`);
  }
});
