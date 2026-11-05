// Runs the browser suites against a static server and a disposable headless Chrome profile.
// Needs Chrome/Chromium, python3 and local sockets (127.0.0.1 only). Its structure was taken from the
// legacy prototype's runner (felix-erp-prototype/tests/run-browser.mjs, last present at commit 0b4283e).
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeBrowserProfile } from "./browser-profile.mjs";

const SUITES = ["browser-smoke.browser.mjs"];

if (typeof WebSocket !== "function")
  throw Error("OPEX+ browser tests require Node.js 22 with native WebSocket support.");
const chrome = [
  process.env.OPEX_CHROME_BINARY,
  process.env.FELIX_CHROME_BINARY,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
]
  .filter(Boolean)
  .find((command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0);
if (!chrome) throw Error("Install Chrome/Chromium or set OPEX_CHROME_BINARY to its executable.");

const prototypeDir = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "opex-prototype-browser-"));
const processes = [];
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const launch = (command, args, options = {}) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], ...options });
  child.diagnostic = "";
  child.stderr?.on("data", (chunk) => {
    child.diagnostic = (child.diagnostic + chunk).slice(-4000);
  });
  child.on("error", (error) => {
    child.launchError = error;
  });
  processes.push(child);
  return child;
};
const waitUntilReady = async (probe, child, name) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.launchError || child.exitCode != null || child.signalCode)
      throw Error(name + " failed to start: " + (child.launchError?.message || child.diagnostic));
    try {
      const result = await probe();
      if (result) return result;
    } catch {
      /* Readiness probes may run before the process binds its socket. */
    }
    await pause(150);
  }
  throw Error(name + " readiness timed out: " + child.diagnostic);
};
const unusedPort = () =>
  new Promise((resolve, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = listener.address().port;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
const stop = (child) =>
  new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode || !child.pid) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
const stopOnSignal = () => processes.forEach((child) => child.kill("SIGTERM"));
process.once("SIGINT", stopOnSignal);
process.once("SIGTERM", stopOnSignal);
try {
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}/`;
  const server = launch(process.env.OPEX_PYTHON_BINARY || "python3", [
    "-m",
    "http.server",
    String(port),
    "--bind",
    "127.0.0.1",
    "--directory",
    prototypeDir,
  ]);
  await waitUntilReady(
    async () =>
      (await fetch(baseURL + "tests/browser/smoke.html", { signal: AbortSignal.timeout(1000) })).ok,
    server,
    "Static server"
  );
  // This sandbox exception is limited to a fresh, disposable test profile.
  const browser = launch(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "about:blank",
  ]);
  const endpoint = await waitUntilReady(
    async () => {
      const browserPort = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
        "\n"
      )[0];
      const url = `http://127.0.0.1:${browserPort}`;
      const targets = await (
        await fetch(url + "/json/list", { signal: AbortSignal.timeout(1000) })
      ).json();
      return targets.some((target) => target.type === "page") ? url : null;
    },
    browser,
    "Chrome"
  );
  for (const filename of SUITES) {
    console.log("Running " + filename + " against isolated browser storage");
    const suite = launch(process.execPath, [fileURLToPath(new URL(filename, import.meta.url))], {
      stdio: "inherit",
      env: { ...process.env, OPEX_CDP_URL: endpoint, OPEX_PROTOTYPE_URL: baseURL },
    });
    await new Promise((resolve, reject) => {
      suite.once("error", reject);
      suite.once("exit", (code, signal) =>
        code === 0 ? resolve() : reject(Error(filename + " failed (" + (signal || code) + ")"))
      );
    });
  }
} finally {
  await Promise.all(processes.map(stop));
  await removeBrowserProfile(profile);
  process.removeListener("SIGINT", stopOnSignal);
  process.removeListener("SIGTERM", stopOnSignal);
}
