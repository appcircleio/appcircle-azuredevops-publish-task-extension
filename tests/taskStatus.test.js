const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TASK_DIR = path.join(__dirname, "..", "task");
const axios = require(require.resolve("axios", { paths: [TASK_DIR] }));

const STATES = {
  unknown: [0, "Unknown"],
  begin: [1, "Begin"],
  canceled: [2, "Canceled"],
  completed: [3, "Completed"],
};
const scripts = {};
const hanging = [];
const calls = {};
const requests = {};

const server = http.createServer((req, res) => {
  const taskId = decodeURIComponent((req.url || "").split("/").pop());
  requests[taskId] = { url: req.url, authorization: req.headers.authorization };
  const count = (calls[taskId] = (calls[taskId] || 0) + 1);
  const script = scripts[taskId] || ["missing"];
  const step = script[Math.min(count, script.length) - 1];
  if (step === "missing") {
    res.writeHead(204);
    res.end();
  } else if (step === "drop") {
    req.socket.destroy();
  } else if (step === "hang") {
    hanging.push(res);
  } else if (step === "html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>login</html>");
  } else if (step.startsWith("http")) {
    res.writeHead(Number(step.slice(4)), { "Content-Type": "application/json" });
    res.end('{"message":"error"}');
  } else {
    const [stateValue, stateName] = STATES[step];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ taskId, stateValue, stateName }));
  }
});

let api;
let task;

function fakeClock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}

let nextId = 0;
function newTask(...script) {
  const taskId = `task-${++nextId}`;
  scripts[taskId] = script;
  return taskId;
}

const check = (taskId, options) => task.checkTaskStatus(api, taskId, options);

let agentTemp;

before(async () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) delete process.env[key];
  }
  agentTemp = fs.mkdtempSync(path.join(os.tmpdir(), "task-status-test-"));
  process.env.AGENT_TEMPDIRECTORY = agentTemp;
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    task = require(path.join(TASK_DIR, "index.js"));
  } finally {
    process.stdout.write = write;
  }
  task.UploadServiceHeaders.token = "token";
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}/` });
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(agentTemp, { recursive: true, force: true });
});

test("resolves when the task reaches Completed after Begin", async () => {
  const clock = fakeClock();
  const taskId = newTask("begin", "begin", "completed");
  assert.equal(await check(taskId, clock), undefined);
  assert.equal(calls[taskId], 3);
  assert.deepEqual(clock.sleeps, [2000, 2000]);
});

test("keeps polling while the state is Unknown", async () => {
  const taskId = newTask("unknown", "unknown", "completed");
  assert.equal(await check(taskId, fakeClock()), undefined);
  assert.equal(calls[taskId], 3);
});

test("fails with the canceled message on state 2", async () => {
  const taskId = newTask("begin", "canceled");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `${taskId} id upload request failed with status Cancelled`,
  });
});

test("waits for a task that appears after a short 204", async () => {
  const taskId = newTask("missing", "missing", "begin", "completed");
  assert.equal(await check(taskId, fakeClock()), undefined);
  assert.equal(calls[taskId], 4);
});

test("fails when the task stays missing past the grace period", async () => {
  const taskId = newTask("missing");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Upload task ${taskId} was not found. Appcircle did not register the task within 60 seconds.`,
  });
  assert.equal(calls[taskId], 31);
});

test("fails on timeout while the task stays in Begin", async () => {
  const taskId = newTask("begin");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Upload task ${taskId} did not complete within 10 minutes. Last state: Begin.`,
  });
  assert.equal(calls[taskId], 301);
});

test("retries transient errors", async () => {
  const taskId = newTask("drop", "http503", "http429", "completed");
  assert.equal(await check(taskId, fakeClock()), undefined);
  assert.equal(calls[taskId], 4);
});

test("fails fast on a non-transient HTTP error", async () => {
  const taskId = newTask("http401");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Could not read the status of upload task ${taskId}: HTTP 401.`,
  });
  assert.equal(calls[taskId], 1);
});

test("fails when the task id is missing", async () => {
  await assert.rejects(check("", fakeClock()), {
    message: "Task ID is not found in the upload response",
  });
});

test("fails on timeout while the errors stay transient", async () => {
  const taskId = newTask("http503");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Upload task ${taskId} did not complete within 10 minutes. Last state: HTTP 503.`,
  });
});

test("fails on timeout while no answer comes back", async () => {
  const taskId = newTask("drop");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Upload task ${taskId} did not complete within 10 minutes. Last state: no response.`,
  });
});

test("stops a status request that gets no answer", { timeout: 5000 }, async () => {
  const taskId = newTask("hang", "completed");
  assert.equal(await check(taskId, { ...fakeClock(), requestTimeoutMs: 100 }), undefined);
  assert.equal(calls[taskId], 2);
});

test("treats a 200 without a readable body like a missing task", async () => {
  const taskId = newTask("html");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Upload task ${taskId} was not found. Appcircle did not register the task within 60 seconds.`,
  });
});

test("fails when the task id is undefined", async () => {
  await assert.rejects(check(undefined, fakeClock()), {
    message: `Task ID is not found in the upload response`,
  });
});

test("fails on timeout while the state stays Unknown", async () => {
  const taskId = newTask("unknown");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Upload task ${taskId} did not complete within 10 minutes. Last state: Unknown.`,
  });
});

test("fails fast on HTTP 404", async () => {
  const taskId = newTask("http404");
  await assert.rejects(check(taskId, fakeClock()), {
    message: `Could not read the status of upload task ${taskId}: HTTP 404.`,
  });
  assert.equal(calls[taskId], 1);
});

test("sends the token and an encoded task id", async () => {
  const taskId = "a/b?c";
  scripts[taskId] = ["completed"];
  assert.equal(await check(taskId, fakeClock()), undefined);
  assert.equal(requests[taskId].url, "/task/v1/tasks/a%2Fb%3Fc");
  assert.equal(requests[taskId].authorization, "Bearer token");
});
