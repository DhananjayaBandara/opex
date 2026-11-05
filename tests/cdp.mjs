// Minimal Chrome DevTools Protocol client for the browser suites (Node 22 native WebSocket).
// It records page errors so a suite can assert that a flow produced none.
const COMMAND_TIMEOUT_MS = 15000;
const WAIT_TIMEOUT_MS = 8000;
const POLL_MS = 100;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function connectPage(endpoint) {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target) throw new Error("No page target is open in the browser.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Could not connect to the browser page."));
  });

  let sequence = 0;
  const pending = new Map();
  const eventWaiters = new Map();
  const problems = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (!call) return;
      if (message.error) call.reject(new Error(JSON.stringify(message.error)));
      else call.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      problems.push(details.exception?.description ?? details.text);
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      problems.push(`${message.params.entry.text} ${message.params.entry.url ?? ""}`.trim());
    }
    for (const resolve of eventWaiters.get(message.method) ?? []) resolve(message.params);
    eventWaiters.delete(message.method);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const nextEvent = (method) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${method}`)),
        COMMAND_TIMEOUT_MS
      );
      const waiters = eventWaiters.get(method) ?? [];
      waiters.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      eventWaiters.set(method, waiters);
    });

  const run = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text);
    }
    return result.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  return {
    run,
    problems: () => [...problems],
    async navigate(url) {
      const loaded = nextEvent("Page.loadEventFired");
      const outcome = await send("Page.navigate", { url });
      if (outcome.errorText) throw new Error(`Navigation to ${url} failed: ${outcome.errorText}`);
      await loaded;
    },
    async reload() {
      const loaded = nextEvent("Page.loadEventFired");
      await send("Page.reload");
      await loaded;
    },
    async waitFor(expression, description = expression) {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await run(expression)) return;
        await pause(POLL_MS);
      }
      throw new Error(`Timed out waiting for: ${description}`);
    },
    close: () => socket.close(),
  };
}
