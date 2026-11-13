export const TASK_POLL_INTERVAL_MS = 2000;
export const TASK_TIMEOUT_MS = 10 * 60 * 1000;
export const TASK_NOT_FOUND_GRACE_MS = 60 * 1000;
export const TASK_REQUEST_TIMEOUT_MS = 30 * 1000;

export interface TaskStatusReply {
  httpStatus: number;
  body?: { stateValue?: number; stateName?: string };
}

export interface TaskPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  notFoundGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
}

const TASK_COMPLETED = 3;
const TASK_CANCELED = 2;

function isTransient(httpStatus: number): boolean {
  return httpStatus === 0 || httpStatus === 429 || httpStatus >= 500;
}

export async function waitForTaskCompletion(
  taskId: string | undefined,
  readStatus: (taskId: string) => Promise<TaskStatusReply>,
  canceledMessage: (taskId: string, stateName: string) => string,
  options: TaskPollOptions = {}
): Promise<void> {
  if (!taskId) {
    throw new Error("Task ID is not found in the upload response");
  }
  const intervalMs = options.intervalMs ?? TASK_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? TASK_TIMEOUT_MS;
  const graceMs = options.notFoundGraceMs ?? TASK_NOT_FOUND_GRACE_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const startedAt = now();
  let lastState = "not found";
  for (;;) {
    const reply = await readStatus(taskId);
    const elapsed = now() - startedAt;
    const state = reply.body?.stateValue;
    if (reply.httpStatus === 200 && typeof state === "number") {
      const stateName = reply.body?.stateName ?? String(state);
      if (state === TASK_COMPLETED) return;
      if (state === TASK_CANCELED) {
        throw new Error(canceledMessage(taskId, stateName));
      }
      lastState = stateName;
    } else if (reply.httpStatus === 200 || reply.httpStatus === 204) {
      if (elapsed >= graceMs) {
        throw new Error(
          `Upload task ${taskId} was not found. Appcircle did not register the task within ${Math.round(graceMs / 1000)} seconds.`
        );
      }
    } else if (isTransient(reply.httpStatus)) {
      lastState =
        reply.httpStatus === 0 ? "no response" : `HTTP ${reply.httpStatus}`;
    } else {
      throw new Error(
        `Could not read the status of upload task ${taskId}: HTTP ${reply.httpStatus}.`
      );
    }
    if (elapsed + intervalMs > timeoutMs) {
      throw new Error(
        `Upload task ${taskId} did not complete within ${Math.round(timeoutMs / 60000)} minutes. Last state: ${lastState}.`
      );
    }
    await sleep(intervalMs);
  }
}
