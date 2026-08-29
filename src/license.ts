import { randomUUID } from "node:crypto";
import { loadCredentialsStore, saveCredentialsStore } from "./credentials";
import { readSecret } from "./secret-input";
import { getUpdateServerUrl } from "./update-check";

type FetchLike = typeof fetch;

export class LicenseClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LicenseClientError";
  }
}

interface LicenseRequest {
  licenseKey: string;
  deviceId: string;
  deviceName?: string;
}

interface LicenseClientOptions {
  serverUrl: string;
  fetchImpl?: FetchLike;
}

/** 与授权服务交互；不携带任何教务账号、对话或模型数据。 */
export function createLicenseClient({ serverUrl, fetchImpl = fetch }: LicenseClientOptions) {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error("授权服务器地址不正确");
  }
  if (url.protocol !== "https:") {
    throw new Error("授权服务器必须使用 HTTPS 地址");
  }
  const baseUrl = url.toString().replace(/\/+$/, "");

  async function request(path: "activate" | "check", body: LicenseRequest): Promise<void> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/license/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new LicenseClientError("unreachable", "无法连接授权服务器");
    }

    let data: { ok?: boolean; error?: string; code?: string } = {};
    try {
      data = (await response.json()) as typeof data;
    } catch {
      /* 非 JSON 的网关错误也按不可达处理 */
    }
    if (!response.ok || !data.ok) {
      throw new LicenseClientError(data.code ?? "rejected", data.error ?? "授权服务器拒绝了请求");
    }
  }

  return {
    activate: (body: LicenseRequest) => request("activate", body),
    check: (body: LicenseRequest) => request("check", body),
  };
}

async function activateInteractively(
  client: ReturnType<typeof createLicenseClient>,
  deviceId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const licenseKey = (await readSecret({ prompt: "请输入 CourseRaptor 激活密钥" })).trim();
    if (!licenseKey) {
      console.log("❌ 激活密钥不能为空");
      continue;
    }
    try {
      await client.activate({ licenseKey, deviceId });
      saveCredentialsStore({
        licenseKey,
        licenseDeviceId: deviceId,
      });
      console.log("✅ 激活成功：该密钥已绑定本机");
      return;
    } catch (error) {
      if (!(error instanceof LicenseClientError) || error.code === "unreachable") throw error;
      console.log(`❌ 激活失败：${error.message}`);
    }
  }
  throw new Error("激活失败次数过多，请联系维护者确认密钥状态");
}

/**
 * 启动前校验授权。没有配置更新服务器时保持开发模式，不阻断本地开发；
 * 正式发布包配置了服务器地址后，首次启动会要求输入独立激活密钥。
 */
export async function ensureLicense(): Promise<void> {
  const serverUrl = getUpdateServerUrl();
  if (!serverUrl) return;

  const stored = loadCredentialsStore();
  const deviceId = stored?.licenseDeviceId ?? randomUUID();
  const client = createLicenseClient({ serverUrl });
  if (!stored?.licenseKey) {
    await activateInteractively(client, deviceId);
    return;
  }

  try {
    await client.check({ licenseKey: stored.licenseKey, deviceId });
    saveCredentialsStore({
      licenseDeviceId: deviceId,
    });
  } catch (error) {
    if (error instanceof LicenseClientError && error.code === "not_activated") {
      // 管理员重置设备后，同一台电脑无需重新输入密钥即可重新绑定。
      await client.activate({ licenseKey: stored.licenseKey, deviceId });
      saveCredentialsStore({
        licenseDeviceId: deviceId,
      });
      return;
    }
    if (error instanceof LicenseClientError) {
      throw new Error(`授权校验失败：${error.message}`);
    }
    throw error;
  }
}

/** /update 下载包需要的授权头；服务端会再次校验密钥状态与绑定设备。 */
export function getLicenseDownloadHeaders(): Record<string, string> {
  const stored = loadCredentialsStore();
  if (!stored?.licenseKey || !stored.licenseDeviceId) {
    throw new Error("未找到本机授权信息，请重启 CourseRaptor 后完成激活");
  }
  return {
    "x-license-key": stored.licenseKey,
    "x-device-id": stored.licenseDeviceId,
  };
}
