/** 设置域：教务账号 / DeepSeek Key / 供应商与模型切换 / 学校切换 / 提示词模板
 *  / QQ 凭证的保存与热生效，外加设置弹窗与数据面板的状态组装、连接诊断、
 *  generated 产物统计清理（复用 /key 的「校验→热生效→加密落盘」）。 */

import fs from "node:fs";
import path from "node:path";
import { attachmentStats } from "../../core/attachment-store";
import { listSessions } from "../../core/chat-sessions";
import { activateProviderKey, config, effectiveProviderKeys } from "../../core/config";
import { loadCredentialsStore, saveCredentialsStore } from "../../core/credentials";
import { generatedDir } from "../../core/document/save";
import { knowledgeStats } from "../../core/knowledge";
import {
  allowedModelIds,
  cachedModelOptions,
  invalidateModelCache,
  validateModelChoice,
} from "../../core/models";
import {
  getDeepSeekKeyStatus,
  getQQBotStatus,
  setProviderApiKey,
  setQQBotCredentials,
} from "../../core/onboarding";
import { isInsideDir } from "../../core/paths";
import {
  CUSTOM_PROVIDER_ID,
  getProviderDef,
  normalizeCustomBaseUrl,
  providerBaseUrl,
  providerOptionList,
  resolveProviderId,
} from "../../core/providers";
import { effectiveQuickQuestions, normalizeQuickQuestions } from "../../core/quick-questions";
import { loadScheduleCache } from "../../core/schedule-cache";
import { listSchoolOptions, school, selectSchool } from "../../core/school";
import { workspaceStats } from "../../core/workspace-data";
import { oneLine } from "./web-tool-events";

// ── 设置：教务账号 + DeepSeek Key（复用 /key 的「校验→热生效→加密落盘」）──

const SOURCE_LABEL: Record<string, string> = {
  env: "来自 .env",
  encrypted: "本机加密",
  unset: "未配置",
};

/** 学校下拉选项的能力说明：按适配器 capabilities 生成，接了什么说什么 */
export function schoolOptionNote(capabilities: readonly string[]): string {
  const labels: Array<[string, string]> = [
    ["schedule", "课表"],
    ["grades", "成绩"],
    ["exams", "考试"],
    ["notices", "通知"],
    ["courseSelection", "选课"],
  ];
  const have = labels.filter(([cap]) => capabilities.includes(cap)).map(([, label]) => label);
  return have.length ? `教务系统已适配：${have.join(" / ")}` : "教务系统已适配";
}

/** 每家供应商「是否有可用 Key」：当前供应商看生效值，其余看加密存储 */
function savedKeyFlags(creds: ReturnType<typeof loadCredentialsStore>): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const [id, key] of Object.entries(effectiveProviderKeys(creds).keys)) {
    if (key) flags[id] = true;
  }
  if (config.deepseekApiKey) flags[config.providerId] = true;
  return flags;
}

/** 给设置弹窗的状态：只有脱敏摘要，永远不回显密码与完整 Key */
export function settingsPayload() {
  const ds = getDeepSeekKeyStatus();
  const qq = getQQBotStatus();
  const creds = loadCredentialsStore();
  return {
    jwgl: {
      configured: !!(config.jwglUsername && config.jwglPassword),
      username: config.jwglUsername || "",
      sourceLabel: SOURCE_LABEL[config.credentialsSource] ?? config.credentialsSource,
      /** 教务账号保存时的学校 id：与当前学校不一致时前端要提醒更新账号 */
      savedSchoolId: creds?.jwglSchoolId,
    },
    deepseek: { ...ds, sourceLabel: SOURCE_LABEL[ds.source] ?? ds.source },
    qq: { ...qq, sourceLabel: SOURCE_LABEL[qq.source] ?? qq.source },
    /** 供应商选择（AI 模型栏第一行）：当前 + 候选 + custom 端点 */
    provider: {
      current: config.providerId,
      label: config.providerLabel,
      options: providerOptionList(),
      customBaseUrl: config.customBaseUrl,
      /** 各供应商是否已存过 Key（只有布尔，不含 Key 本身）：切换时免重填的依据 */
      keySaved: savedKeyFlags(creds),
      /** 托管版禁自定义端点（防实例探测内网），前端据此隐藏 custom 选项 */
      hosted: config.hosted,
    },
    model: config.model,
    /** 下拉候选：只读同步缓存/兜底清单，联网刷新走 GET /api/models，别卡住弹窗 */
    models: cachedModelOptions(config.providerId),
    /** 输入框上方「提示词」模板的当前生效清单（未自定义时为默认） */
    quickQuestions: effectiveQuickQuestions(creds?.webQuickQuestions),
    /** 学校选择（设置第一栏）：当前学校 + 可选清单 + 手动课表状态 */
    school: {
      current: school().info.id,
      /** 手动课表模式下教务账号栏隐藏、各面板给「未适配」空态 */
      manual: school().info.manual === true,
      /** 教务通知卡门槛：本校接入教务通知且教务账号已保存才显示；
       *  没接入的学校（custom）宫格直接不出「教务通知」卡 */
      newsReady: !!school().notices && !!(config.jwglUsername && config.jwglPassword),
      /** 已有导入课表缓存（「去导入课表」与「重新导入」的文案分叉） */
      scheduleCached: !!loadScheduleCache(),
      custom: {
        name: creds?.customSchoolName ?? "",
        city: creds?.customCity ?? "",
      },
      options: listSchoolOptions().map((a) => ({
        id: a.info.id,
        name: a.info.name,
        shortName: a.info.shortName,
        manual: a.info.manual === true,
        /** 能力说明按本校 capabilities 如实生成（没接通知就不写通知） */
        note: a.info.manual ? undefined : schoolOptionNote(a.capabilities),
      })),
    },
  };
}

/** 预览其他供应商清单的 Key：只从加密存储取该供应商已存值（没存过就走兜底清单） */
export function providerKeyPreview(providerId: string): string {
  return effectiveProviderKeys(loadCredentialsStore()).keys[providerId] ?? "";
}

export async function runDiagnostic(target: unknown): Promise<SettingResult> {
  if (target === "jwgl") {
    if (!config.jwglUsername || !config.jwglPassword) {
      return { field: "jwgl", ok: false, message: "请先保存完整的教务账号" };
    }
    try {
      await school().auth.getCookie(true);
      return { field: "jwgl", ok: true, message: "教务系统连接正常，账号可以使用" };
    } catch (error) {
      return {
        field: "jwgl",
        ok: false,
        message: `教务连接失败：${oneLine(error instanceof Error ? error.message : String(error), 120)}`,
      };
    }
  }
  if (target === "deepseek") {
    if (!config.deepseekApiKey) {
      return { field: "deepseek", ok: false, message: "请先保存 API Key" };
    }
    const base = config.providerBaseUrl.replace(/\/+$/, "");
    try {
      const response = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${config.deepseekApiKey}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        return {
          field: "deepseek",
          ok: false,
          message:
            response.status === 401 || response.status === 403
              ? "模型连接失败：API Key 无效或没有权限"
              : `模型连接失败：服务返回 HTTP ${response.status}`,
        };
      }
      return {
        field: "deepseek",
        ok: true,
        message: `模型服务连接正常 · ${config.providerLabel} ${config.model}`,
      };
    } catch (error) {
      return {
        field: "deepseek",
        ok: false,
        message: `模型连接失败：${oneLine(error instanceof Error ? error.message : String(error), 100)}`,
      };
    }
  }
  return { field: "unknown", ok: false, message: "未知的检测项目" };
}

export function generatedStats(): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(generatedDir(), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      count++;
      bytes += fs.statSync(path.join(generatedDir(), entry.name)).size;
    }
  } catch {
    // 目录尚未创建就是零占用
  }
  return { count, bytes };
}

export function clearGenerated(): number {
  let removed = 0;
  const root = path.resolve(generatedDir());
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const target = path.resolve(root, entry.name);
      if (!isInsideDir(root, target)) continue;
      fs.rmSync(target, { force: true });
      removed++;
    }
  } catch {
    // 目录不存在或文件正被占用：保留未删项目
  }
  return removed;
}

export function dataPayload() {
  const sessions = listSessions();
  const attachments = attachmentStats();
  const workspace = workspaceStats();
  return {
    sessions: { count: sessions.length, messages: sessions.reduce((n, s) => n + s.count, 0) },
    attachments: { count: attachments.count, bytes: attachments.totalBytes },
    uploads: workspace.uploads,
    generated: generatedStats(),
    reminders: workspace.reminders,
    knowledge: knowledgeStats(),
  };
}

export interface SettingResult {
  field: string;
  ok: boolean;
  message: string;
}

export function applySettings(body: Record<string, unknown>): {
  ok: boolean;
  results: SettingResult[];
  status: ReturnType<typeof settingsPayload>;
  modelChanged: boolean;
  schoolChanged: boolean;
  providerChanged: boolean;
} {
  const results: SettingResult[] = [];
  let schoolChanged = false;
  let providerChanged = false;
  // 学校切换（设置第一栏）：保存偏好 + 运行期换适配器；工具集跟 agent 重建换新
  const schoolId = typeof body.schoolId === "string" ? body.schoolId.trim() : "";
  if (schoolId) {
    const currentSchoolId = school().info.id;
    if (schoolId === currentSchoolId) {
      results.push({ field: "school", ok: true, message: "所选学校已是当前学校，无需切换" });
    } else if (selectSchool(schoolId)) {
      const name = listSchoolOptions().find((a) => a.info.id === schoolId)?.info.name ?? schoolId;
      // 教务账号按学校分槽：旧学校的账号存回它名下（不删，切回来还在），
      // 新学校有自己的账号就载入，没有就清空等用户填——绝不能拿 A 校账号去登 B 校
      const store = loadCredentialsStore();
      const accounts: Record<string, { username: string; password: string }> = {
        ...(store?.jwglAccounts ?? {}),
      };
      const hadActive = !!(config.jwglUsername && config.jwglPassword);
      const fromEnv = config.credentialsSource === "env";
      if (hadActive && !fromEnv) {
        accounts[currentSchoolId] = {
          username: config.jwglUsername,
          password: config.jwglPassword,
        };
      }
      const next = accounts[schoolId] ?? null;
      saveCredentialsStore({
        schoolId,
        jwglAccounts: accounts,
        username: next?.username ?? "",
        password: next?.password ?? "",
        jwglSchoolId: next ? schoolId : undefined,
      });
      config.jwglUsername = next?.username ?? "";
      config.jwglPassword = next?.password ?? "";
      config.credentialsSource = next ? "encrypted" : hadActive && fromEnv ? "env" : "unset";
      schoolChanged = true;
      let message = `学校已切换为「${name}」：对话与各面板下一条起生效（终端界面重启后生效）`;
      if (next) {
        message += `。已载入本校保存的教务账号（学号 ${next.username.slice(0, 4)}****）`;
      } else if (hadActive && fromEnv) {
        message += `。⚠️ 当前教务账号来自 .env 配置（属原学校），查询${name}前请在下方保存本校学号与密码`;
      } else {
        message += `。本校还没有保存教务账号，请在下方填写${name}的学号与密码后保存`;
      }
      results.push({ field: "school", ok: true, message });
    } else {
      results.push({
        field: "school",
        ok: false,
        message: `未知学校「${schoolId}」，请重新选择`,
      });
    }
  }
  // 自定义学校的显示名/城市（跟着学校切换一起保存也行，单独保存也行）
  if (body.customSchoolName !== undefined || body.customCity !== undefined) {
    const name = typeof body.customSchoolName === "string" ? body.customSchoolName.trim() : "";
    const city = typeof body.customCity === "string" ? body.customCity.trim() : "";
    saveCredentialsStore({
      customSchoolName: name.slice(0, 40),
      customCity: city.slice(0, 20),
    });
    results.push({ field: "school", ok: true, message: "自定义学校信息已保存" });
  }
  const user = typeof body.jwglUsername === "string" ? body.jwglUsername.trim() : "";
  const pass = typeof body.jwglPassword === "string" ? body.jwglPassword : "";
  if (user || pass) {
    if (!user || !pass) {
      results.push({ field: "jwgl", ok: false, message: "学号与密码需要一起提交" });
    } else {
      // 按学校入槽：这份账号属于当前学校；username/password 镜像当前校供旧读取端
      const sid = school().info.id;
      const accounts = { ...(loadCredentialsStore()?.jwglAccounts ?? {}) };
      accounts[sid] = { username: user, password: pass };
      saveCredentialsStore({
        username: user,
        password: pass,
        jwglSchoolId: sid,
        jwglAccounts: accounts,
      });
      config.jwglUsername = user;
      config.jwglPassword = pass;
      config.credentialsSource = "encrypted";
      results.push({ field: "jwgl", ok: true, message: "教务账号已加密保存，下次查询即生效" });
    }
  }
  // ── 供应商 / 自定义端点 / API Key（AI 模型栏）──
  // 托管版：供应商由网关 users.json 管理（前端走网关 /api/provider），实例
  // 不收这两个字段；custom 端点在托管版一律拒绝（防实例探测内网）。
  const rawProvider = typeof body.providerId === "string" ? body.providerId.trim() : "";
  const rawCustomUrl = typeof body.customBaseUrl === "string" ? body.customBaseUrl : "";
  const touchesProvider = !!rawProvider || body.customBaseUrl !== undefined;
  if (touchesProvider && config.hosted) {
    results.push({
      field: "provider",
      ok: false,
      message: "当前环境由站点托管：供应商切换走站点接口，自定义端点不可用",
    });
  } else if (touchesProvider) {
    const nextId = rawProvider ? resolveProviderId(rawProvider) : config.providerId;
    const urlCheck = body.customBaseUrl !== undefined ? normalizeCustomBaseUrl(rawCustomUrl) : null;
    if (urlCheck && !urlCheck.ok) {
      results.push({ field: "provider", ok: false, message: urlCheck.message });
    } else if (nextId !== config.providerId) {
      // 切换供应商：custom 必须有地址（本次提交或既有存值）；旧供应商的型号
      // 记入 providerModels，新供应商恢复上次记忆或兜底第一项。
      const hasCustomUrl = urlCheck?.url || config.customBaseUrl;
      if (nextId === CUSTOM_PROVIDER_ID && !hasCustomUrl) {
        results.push({
          field: "provider",
          ok: false,
          message: "选择自定义供应商时请一并填写服务地址（https://…）",
        });
      } else {
        const def = getProviderDef(nextId);
        const stored = loadCredentialsStore();
        const providerModels = {
          ...(stored?.providerModels ?? {}),
          [config.providerId]: config.model,
        };
        const nextModel = providerModels[nextId] ?? def.fallbackModels[0]?.id ?? config.model;
        // custom 地址是「custom 供应商的持久配置」：切到别的供应商不清空，
        // 切回来还在；本次带新地址则更新
        const nextCustomUrl = urlCheck?.url || config.customBaseUrl;
        config.providerId = def.id;
        config.providerLabel = def.label;
        config.customBaseUrl = nextCustomUrl;
        config.providerBaseUrl = providerBaseUrl(def.id, nextCustomUrl);
        config.model = nextModel;
        saveCredentialsStore({
          providerId: def.id,
          customBaseUrl: nextCustomUrl,
          providerModels,
          model: nextModel,
          modelOverride: true,
        });
        // 装载新供应商自己的 Key（每家一把，切回来不用重填；没存过则清空）
        activateProviderKey(def.id);
        invalidateModelCache();
        providerChanged = true;
        const keyNote = config.deepseekApiKey
          ? "，已自动载入该供应商保存的 Key"
          : "，该供应商还没有保存 Key，请在下方填写一次";
        results.push({
          field: "provider",
          ok: true,
          message: `供应商已切换为「${def.label}」${keyNote}`,
        });
      }
    } else if (body.customBaseUrl !== undefined && urlCheck?.ok) {
      // 只更新 custom 地址（供应商未变）：清单跟地址走，一并作废
      config.customBaseUrl = urlCheck.url;
      config.providerBaseUrl = providerBaseUrl(config.providerId, urlCheck.url);
      saveCredentialsStore({ customBaseUrl: urlCheck.url });
      invalidateModelCache();
      providerChanged = true;
      results.push({ field: "provider", ok: true, message: "自定义服务地址已保存" });
    }
  }
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (key) {
    // Key 存到「本次提交后的供应商」（供应商切换在上一段已生效）
    const r = setProviderApiKey(config.providerId, key);
    results.push({ field: "apiKey", ok: r.ok, message: r.message.replace(/^[✅❌]\s*/, "") });
    // 可用型号跟 Key 走：换 Key 后旧清单作废，下次打开弹窗重新拉
    if (r.ok) invalidateModelCache();
  }
  const qqPatch: { appId?: string; appSecret?: string; passcode?: string } = {};
  if (typeof body.qqAppId === "string" && body.qqAppId.trim()) qqPatch.appId = body.qqAppId.trim();
  if (typeof body.qqAppSecret === "string" && body.qqAppSecret.trim()) {
    qqPatch.appSecret = body.qqAppSecret.trim();
  }
  if (typeof body.qqPasscode === "string" && body.qqPasscode.trim()) {
    qqPatch.passcode = body.qqPasscode.trim();
  }
  if (qqPatch.appId || qqPatch.appSecret || qqPatch.passcode) {
    const r = setQQBotCredentials(qqPatch);
    results.push({ field: "qq", ok: r.ok, message: r.message.replace(/^[✅❌]\s*/, "") });
  }
  // 「提示词」模板清单：数组整体替换（提示词模板面板按条编辑、即改即存）；
  // 空/形状不对按空清单处理——空清单即恢复默认，不用单独的「重置」协议
  if (body.quickQuestions !== undefined) {
    const normalized = normalizeQuickQuestions(body.quickQuestions);
    saveCredentialsStore({ webQuickQuestions: normalized });
    results.push({
      field: "quickQuestions",
      ok: true,
      message: normalized.length
        ? `提示词模板已保存（${normalized.length} 条），输入框上方已同步更新`
        : "提示词模板已清空，恢复默认清单",
    });
  }
  let modelChanged = false;
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  if (requestedModel) {
    // custom 供应商型号靠手输：清单拉不到时不卡白名单（形状校验仍在）；
    // 内置厂商维持白名单，防手滑存进无效 id。
    const allowed =
      config.providerId === CUSTOM_PROVIDER_ID
        ? allowedModelIds(
            cachedModelOptions(config.providerId).map((m) => m.id),
            [config.model],
            [requestedModel],
          )
        : allowedModelIds(
            cachedModelOptions(config.providerId).map((m) => m.id),
            [config.model],
          );
    const r = validateModelChoice({
      requested: requestedModel,
      allowed,
      current: config.model,
      providerId: config.providerId,
    });
    if (r.ok && r.model === config.model) {
      results.push({ field: "model", ok: true, message: "所选模型已是当前值，无需切换" });
    } else {
      results.push({ field: "model", ok: r.ok, message: r.message });
      if (r.ok) {
        config.model = r.model;
        // 型号随供应商分别记忆：切回旧供应商时还能找回上次的型号
        const providerModels = {
          ...(loadCredentialsStore()?.providerModels ?? {}),
          [config.providerId]: r.model,
        };
        saveCredentialsStore({ model: r.model, modelOverride: true, providerModels });
        modelChanged = true;
      }
    }
  }
  if (!results.length) {
    results.push({ field: "none", ok: true, message: "没有需要保存的修改" });
  }
  return {
    ok: results.every((r) => r.ok),
    results,
    status: settingsPayload(),
    modelChanged,
    schoolChanged,
    providerChanged,
  };
}
