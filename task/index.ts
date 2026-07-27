import * as tl from "azure-pipelines-task-lib/task";
import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import * as fs from "fs";
import * as FormData from "form-data";
import * as path from "path";

const FLOW_STEP_STATUS: Record<number, string> = {
  0: "Success", 1: "Failed", 2: "Cancelled", 3: "Timeout",
  90: "Waiting", 91: "Running", 92: "Completing", 99: "Unknown",
  100: "Skipped", 200: "Not Started", 201: "Stopped",
  202: "In Progress", 203: "Awaiting Response",
};
const TERMINAL_STEP_STATUSES = new Set([0, 1, 2, 3, 100, 201]);
const ACTIVE_STEP_STATUSES = new Set([91, 92, 202]);

function stepStatusName(status: number): string {
  return FLOW_STEP_STATUS[status] ?? `Unknown (${status})`;
}
// Emoji icons carry green/red semantics without ANSI codes, so they render in CI logs.
function stepIcon(status: number): string {
  switch (status) {
    case 0: return "✅";
    case 1: return "❌";
    case 2: return "🚫";
    case 3: return "⌛";
    case 100: return "⏭️";
    case 201: return "⏹️";
    case 203: return "⏸️";
    default: return "▶️";
  }
}

async function run() {
  try {
    const personalAPIToken = tl.getInputRequired("personalAPIToken");
    const authEndpoint = tl.getInput("authEndpoint") ?? "https://auth.appcircle.io";
    const apiEndpoint = tl.getInput("apiEndpoint") ?? "https://api.appcircle.io";
    const platform = (tl.getInputRequired("platform") || "").toLowerCase();
    const publishProfile = tl.getInputRequired("publishProfile");
    const upload = tl.getBoolInput("upload");
    const publish = tl.getBoolInput("publish");
    const appPath = tl.getInput("appPath");
    const subOrganizationName = tl.getInput("subOrganizationName");

    // --- Validation ---
    if (!upload && !publish) {
      tl.setResult(tl.TaskResult.Failed, "Nothing to do: enable 'upload' and/or 'publish'.");
      return;
    }
    if (platform !== "ios" && platform !== "android") {
      tl.setResult(tl.TaskResult.Failed, `Invalid platform: ${platform}. Use 'ios' or 'android'.`);
      return;
    }
    if (upload) {
      if (!appPath) {
        tl.setResult(tl.TaskResult.Failed, "'appPath' is required when 'upload' is enabled.");
        return;
      }
      const validExtensions = [".apk", ".aab", ".ipa"];
      const fileExtension = appPath.slice(appPath.lastIndexOf(".")).toLowerCase();
      if (!validExtensions.includes(fileExtension)) {
        tl.setResult(tl.TaskResult.Failed, `Invalid file extension: ${appPath}. For Android, use .apk or .aab. For iOS, use .ipa.`);
        return;
      }
    }

    const appcircleApi = axios.create({ baseURL: new URL(apiEndpoint).toString() });

    const loginResponse = await getToken(personalAPIToken, authEndpoint);
    UploadServiceHeaders.token = loginResponse.access_token;
    console.log("Logged in to Appcircle successfully");

    if (subOrganizationName) {
      const subOrganizationId = await getOrganizationId(
        appcircleApi,
        subOrganizationName
      );
      const subLoginResponse = await getToken(
        personalAPIToken,
        authEndpoint,
        subOrganizationId
      );
      UploadServiceHeaders.token = subLoginResponse.access_token;
      console.log(`Switched to sub-organization: ${subOrganizationName}`);
    }

    const publishProfileId = await getPublishProfileId(appcircleApi, platform, publishProfile);

    // Guard: never start a new publish if one is already running for the profile.
    if (publish) {
      const active = await getActivePublishCountForProfile(appcircleApi, publishProfileId);
      if (active > 0) {
        tl.setResult(tl.TaskResult.Failed, `A publish is already in progress for profile '${publishProfile}'. Not starting a new one.`);
        return;
      }
    }

    let appVersionId: string | undefined;

    // --- Upload ---
    if (upload) {
      const uploadResponse = await uploadPublishApp(appcircleApi, platform, publishProfileId, appPath as string);
      const ok = await checkTaskStatus(appcircleApi, uploadResponse.taskId);
      if (!ok) {
        tl.setResult(tl.TaskResult.Failed, `${uploadResponse.taskId} id upload request failed with status Cancelled`);
        return;
      }
      appVersionId = await getLatestAppVersionId(appcircleApi, platform, publishProfileId);
      console.log(`${appPath} uploaded to the Appcircle Publish profile '${publishProfile}' successfully`);
    }

    // --- Publish ---
    if (publish) {
      if (upload && appVersionId) {
        await markReleaseCandidate(appcircleApi, platform, publishProfileId, appVersionId);
        console.log("Marked the uploaded version as release candidate.");
      } else {
        appVersionId = await getReleaseCandidateVersionId(appcircleApi, platform, publishProfileId);
      }
      const publishId = await getPublishId(appcircleApi, platform, publishProfileId, appVersionId as string);
      await startPublish(appcircleApi, platform, publishProfileId, publishId);
      console.log(`Publish flow started for profile '${publishProfile}'.`);
      const success = await pollPublishStatus(appcircleApi, platform, publishProfileId, appVersionId as string);
      if (!success) {
        tl.setResult(tl.TaskResult.Failed, "Publish flow failed.");
        return;
      }
    }

    tl.setResult(tl.TaskResult.Succeeded, "Appcircle Publish action completed successfully.");
  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err.message);
  }
}

run();

/* API */

export async function getToken(
  pat: string,
  authEndpoint: string,
  subOrganizationId?: string
): Promise<any> {
  const params = new URLSearchParams();
  params.append("pat", pat);

  // Sub-org scoping requires the v2 token endpoint. When no sub-org is
  // requested, keep the exact v1 behavior for zero regression.
  const tokenPath = subOrganizationId ? "/auth/v2/token" : "/auth/v1/token";
  if (subOrganizationId) {
    params.append("subOrganizationId", subOrganizationId);
  }

  try {
    const url = new URL(tokenPath, authEndpoint).toString();
    const response = await axios.post(url, params.toString(), {
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("Axios error:", error.message);
      if (error.response) {
        console.error("Response status:", error.response.status);
      }
    } else {
      console.error("Unexpected error:", error);
    }
    throw error;
  }
}

export async function getOrganizationId(
  api: AxiosInstance,
  name: string
): Promise<string> {
  const response = await api.get(`identity/v1/organizations`, {
    headers: UploadServiceHeaders.getHeaders(),
  });
  const organizations: Array<{ id: string; name: string }> =
    response.data?.data ?? [];
  const organization = organizations.find((org) => org.name === name);
  if (!organization) {
    throw new Error(
      `Sub-organization '${name}' could not be found or is not accessible with this token.`
    );
  }
  return organization.id;
}

export class UploadServiceHeaders {
  static token = "";
  static getHeaders = (): AxiosRequestConfig["headers"] => {
    let response: AxiosRequestConfig["headers"] = {
      accept: "application/json",
      "User-Agent": "Appcircle Azure DevOps Extension",
    };
    response.Authorization = `Bearer ${UploadServiceHeaders.token}`;
    return response;
  };
}

export async function getPublishProfileId(api: AxiosInstance, platform: string, profileName: string): Promise<string> {
  const response = await api.get(`publish/v2/profiles/${platform}`, {
    headers: UploadServiceHeaders.getHeaders(),
  });
  const profiles = Array.isArray(response.data) ? response.data : (response.data?.data ?? []);
  const profile = profiles.find((p: any) => p.name === profileName);
  if (!profile) {
    throw new Error(`Publish profile '${profileName}' not found for platform '${platform}'.`);
  }
  return profile.id;
}

export async function getAppVersions(api: AxiosInstance, platform: string, publishProfileId: string): Promise<any[]> {
  const response = await api.get(
    `publish/v2/profiles/${platform}/${publishProfileId}/app-versions`,
    { headers: UploadServiceHeaders.getHeaders() }
  );
  return Array.isArray(response.data) ? response.data : (response.data?.data ?? []);
}

export async function getLatestAppVersionId(api: AxiosInstance, platform: string, publishProfileId: string): Promise<string> {
  const versions = await getAppVersions(api, platform, publishProfileId);
  if (!versions.length) {
    throw new Error("No app versions found on the publish profile after upload.");
  }
  return versions[0].id;
}

export async function getReleaseCandidateVersionId(api: AxiosInstance, platform: string, publishProfileId: string): Promise<string> {
  const versions = await getAppVersions(api, platform, publishProfileId);
  const rc = versions.find((v: any) => v.releaseCandidate === true);
  if (!rc) {
    throw new Error("No release candidate app version found on the publish profile. Mark a version as release candidate (or enable upload) before publishing.");
  }
  return rc.id;
}

export async function markReleaseCandidate(api: AxiosInstance, platform: string, publishProfileId: string, appVersionId: string): Promise<void> {
  await api.patch(
    `publish/v2/profiles/${platform}/${publishProfileId}/app-versions/${appVersionId}?action=releaseCandidate`,
    { ReleaseCandidate: true },
    { headers: { ...UploadServiceHeaders.getHeaders(), "Content-Type": "application/json" } }
  );
}

export async function getActivePublishCountForProfile(api: AxiosInstance, publishProfileId: string): Promise<number> {
  const response = await api.get(`build/v1/queue/my-dashboard?page=1&size=1000`, {
    headers: UploadServiceHeaders.getHeaders(),
  });
  const items = response.data?.data ?? [];
  return items.filter((p: any) => p.publishId != null && p.profileId === publishProfileId).length;
}

const RETRYABLE_UPLOAD_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_UPLOAD_CODES = new Set(["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN"]);

async function uploadWithRetry(doUpload: () => Promise<any>, maxRetries = 5): Promise<any> {
  let attempt = 0;
  let delay = 1000;
  while (true) {
    try {
      return await doUpload();
    } catch (error: any) {
      const status = error?.response?.status;
      const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
      const retryable =
        (typeof status === "number" && RETRYABLE_UPLOAD_STATUSES.has(status)) ||
        (typeof error?.code === "string" && RETRYABLE_UPLOAD_CODES.has(error.code)) ||
        message.includes("socket hang up");
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }
      attempt++;
      const jitter = Math.floor(Math.random() * 300);
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      delay *= 2;
    }
  }
}

export async function uploadPublishApp(api: AxiosInstance, platform: string, publishProfileId: string, app: string) {
  const filePath = app;
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  // Profile listing is v2, but the signed-URL upload/commit actions live on v1.
  const basePath = `publish/v1/profiles/${platform}/${publishProfileId}/app-versions`;

  console.log("Getting file upload information...");
  const uploadInfoResponse = await api.get<{
    fileId: string;
    uploadUrl: string;
    configuration?: { httpMethod: string; signParameters: Record<string, string> };
  }>(basePath, {
    params: { action: "uploadInformation", fileName, fileSize },
    headers: UploadServiceHeaders.getHeaders(),
  });
  const { fileId, uploadUrl, configuration } = uploadInfoResponse.data;
  const httpMethod = configuration?.httpMethod?.toUpperCase() ?? "PUT";
  const signParameters = configuration?.signParameters ?? {};

  console.log("Uploading file to Appcircle...");
  if (httpMethod === "POST") {
    await uploadWithRetry(() => {
      // @ts-ignore
      const data = new FormData();
      for (const [key, value] of Object.entries(signParameters)) {
        data.append(key, value);
      }
      data.append("file", fs.createReadStream(filePath), fileName);
      return axios.post(uploadUrl, data, {
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...data.getHeaders() },
      });
    });
  } else {
    await uploadWithRetry(() =>
      axios.put(uploadUrl, fs.readFileSync(filePath), {
        headers: { "Content-Type": "application/octet-stream" },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      })
    );
  }

  console.log("Committing file upload...");
  const commitResponse = await api.post<{ taskId: string }>(
    basePath,
    { fileId, fileName },
    { params: { action: "commitFileUpload" }, headers: UploadServiceHeaders.getHeaders() }
  );
  return commitResponse.data;
}

export async function checkTaskStatus(api: AxiosInstance, taskId: string, currentAttempt = 0) {
  const response = await api.get(`/task/v1/tasks/${taskId}`, {
    headers: UploadServiceHeaders.getHeaders(),
  });
  if (response?.data.stateValue == 1 && currentAttempt < 100) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return checkTaskStatus(api, taskId, currentAttempt + 1);
  }
  if (response.data.stateValue === 2) {
    return false;
  }
  return true;
}

export async function getPublishId(api: AxiosInstance, platform: string, publishProfileId: string, appVersionId: string): Promise<string> {
  const response = await api.get(
    `publish/v2/profiles/${platform}/${publishProfileId}/app-versions/${appVersionId}/publish`,
    { headers: UploadServiceHeaders.getHeaders() }
  );
  const steps = response.data?.steps ?? [];
  const publishId = steps[0]?.publishId;
  if (!publishId) {
    throw new Error("No publish flow steps found for the app version. Configure a publish flow on the profile first.");
  }
  return publishId;
}

export async function startPublish(api: AxiosInstance, platform: string, publishProfileId: string, publishId: string): Promise<void> {
  await api.post(
    `publish/v2/profiles/${platform}/${publishProfileId}/publish/${publishId}?action=restart`,
    "{}",
    { headers: { ...UploadServiceHeaders.getHeaders(), "Content-Type": "application/json" } }
  );
}

// Poll the publish status until terminal (0=success, 1=failed, else running),
// logging each step's start / await / terminal once with status icons.
export async function pollPublishStatus(
  api: AxiosInstance,
  platform: string,
  publishProfileId: string,
  appVersionId: string,
  intervalMs = 5000,
  maxAttempts = 240
): Promise<boolean> {
  const stepState: Record<string, { started?: boolean; awaiting?: boolean; done?: boolean }> = {};
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await api.get(
      `publish/v1/profiles/${platform}/${publishProfileId}/app-versions/${appVersionId}/publish`,
      { headers: UploadServiceHeaders.getHeaders() }
    );
    const data = response.data ?? {};
    const steps = data.steps ?? [];
    for (const step of steps) {
      const id = step.id ?? step.name;
      if (!id) continue;
      const state = (stepState[id] ??= {});
      const status = step.status;
      if (TERMINAL_STEP_STATUSES.has(status) && !state.done) {
        state.done = true;
        console.log(`${stepIcon(status)} ${step.name} — ${stepStatusName(status)}`);
      } else if (status === 203 && !state.awaiting && !state.done) {
        state.awaiting = true;
        console.log(`${stepIcon(status)} ${step.name} — ${stepStatusName(status)}`);
      } else if (ACTIVE_STEP_STATUSES.has(status) && !state.started && !state.done) {
        state.started = true;
        console.log(`${stepIcon(status)} ${step.name} — ${stepStatusName(status)}`);
      }
    }
    const status = typeof data.status === "number" ? data.status : 99;
    if (status === 0) {
      console.log("Publish completed successfully.");
      return true;
    }
    if (status === 1) {
      console.log("Publish failed.");
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Publish status polling timed out.");
}
