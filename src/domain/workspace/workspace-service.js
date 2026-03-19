const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const {
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
} = require("../../shared/workspace-paths");
const {
  extractBindPath,
  extractBuild8123ProjectName,
  extractBuild2223ProjectName,
  extractEffortValue,
  extractListPath,
  extractModelValue,
  extractRemoveWorkspacePath,
  extractSendPath,
} = require("../../shared/command-parsing");
const {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  normalizeText,
  resolveEffectiveModelForEffort,
} = require("../../shared/model-catalog");
const codexMessageUtils = require("../../infra/codex/message-utils");
const { formatFailureText } = require("../../shared/error-text");

const MAX_FEISHU_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;
const NGINX_CONFIG_PATH = "/usr/local/etc/nginx/nginx.conf";
const NGINX_APPS_ROOT = "/usr/local/var/www/workplace/apps";
const VALID_PROJECT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_DIRECTORY_LIST_ITEMS_PER_GROUP = 100;
const execFileAsync = promisify(execFile);

async function resolveWorkspaceContext(
  runtime,
  normalized,
  {
    replyToMessageId = "",
    missingWorkspaceText = "当前会话还没有绑定项目。",
  } = {}
) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: missingWorkspaceText,
    });
    return null;
  }

  return { bindingKey, workspaceRoot, replyTarget };
}

async function handleBindCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const rawWorkspaceRoot = extractBindPath(normalized.text);
  if (!rawWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex bind /绝对路径`",
    });
    return;
  }

  const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "只支持绝对路径绑定。Windows 例如 `C:\\code\\repo`，macOS/Linux 例如 `/Users/name/repo`。",
    });
    return;
  }
  if (!isWorkspaceAllowed(workspaceRoot, runtime.config.workspaceAllowlist)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "该项目不在允许绑定的白名单中。",
    });
    return;
  }

  const workspaceStats = await runtime.resolveWorkspaceStats(workspaceRoot);
  if (!workspaceStats.exists) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `项目不存在: ${workspaceRoot}`,
    });
    return;
  }

  if (!workspaceStats.isDirectory) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `路径非法: ${workspaceRoot}`,
    });
    return;
  }

  applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot);
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  await runtime.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
  const existingThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  await showStatusPanel(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: existingThreadId
      ? "已切换到项目，并恢复原会话上下文。"
      : "已绑定项目。",
  });
}

async function handleBuild8123Command(runtime, normalized) {
  await handleBuildCommand(runtime, normalized, {
    port: 8123,
    commandName: "build8123",
    extractProjectName: extractBuild8123ProjectName,
  });
}

async function handleBuild2223Command(runtime, normalized) {
  await handleBuildCommand(runtime, normalized, {
    port: 2223,
    commandName: "build2223",
    extractProjectName: extractBuild2223ProjectName,
  });
}

async function handleWhereCommand(runtime, normalized) {
  await showStatusPanel(runtime, normalized);
}

async function handleBuildCommand(runtime, normalized, { port, commandName, extractProjectName }) {
  const projectName = extractProjectName(normalized.text);
  if (!projectName) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `用法: \`/codex ${commandName} <projectName>\``,
    });
    return;
  }

  try {
    const result = await updateNginxProjectRootAndReload({
      port,
      projectName,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildNginxBuildSuccessText(result),
    });
  } catch (error) {
    console.warn(
      `[codex-im] nginx/build failed port=${port} project=${projectName}: ${error.message}`
    );
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("更新 Nginx 配置失败", error),
    });
  }
}

async function showStatusPanel(runtime, normalized, { replyToMessageId, noticeText = "" } = {}) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, { replyToMessageId });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot, replyTarget } = workspaceContext;

  const { threads, threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });
  const currentThread = threads.find((thread) => thread.id === threadId) || null;
  const recentThreads = currentThread
    ? threads.filter((thread) => thread.id !== threadId).slice(0, 2)
    : threads.slice(0, 3);
  const status = runtime.describeWorkspaceStatus(threadId);
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const modelOptions = buildModelSelectOptions(availableModels);
  const effortOptions = buildEffortSelectOptions(availableModels, codexParams?.model || "");
  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildStatusPanelCard({
      workspaceRoot,
      codexParams,
      modelOptions,
      effortOptions,
      threadId,
      currentThread,
      recentThreads,
      totalThreadCount: threads.length,
      status,
      noticeText,
    }),
  });
}

async function handleMessageCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const { threads, threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `当前项目：\`${workspaceRoot}\`\n\n该项目还没有可查看的线程消息。`,
    });
    return;
  }

  const currentThread = threads.find((thread) => thread.id === threadId) || { id: threadId };
  runtime.resumedThreadIds.delete(threadId);
  const resumeResponse = await runtime.ensureThreadResumed(threadId);
  const recentMessages = codexMessageUtils.extractRecentConversationFromResumeResponse(resumeResponse);

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: runtime.buildThreadMessagesSummary({
      workspaceRoot,
      thread: currentThread,
      recentMessages,
    }),
  });
}

async function handleHelpCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: runtime.buildHelpCardText(),
  });
}

async function handleUnknownCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: "无效的 Codex 命令。\n\n可使用 `/codex help` 查看命令教程。",
  });
}

async function handleSendCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
  if (!workspaceContext) {
    return;
  }
  const { workspaceRoot } = workspaceContext;

  const requestedPath = extractSendPath(normalized.text);
  if (!requestedPath) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex send <当前项目下的相对文件路径>`",
    });
    return;
  }

  const resolvedTarget = resolveWorkspaceSendTarget(workspaceRoot, requestedPath);
  if (resolvedTarget.errorText) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: resolvedTarget.errorText,
    });
    return;
  }

  let fileStats;
  try {
    fileStats = await fs.promises.stat(resolvedTarget.filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `文件不存在: ${resolvedTarget.displayPath}`,
      });
      return;
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `只支持发送文件，不支持目录: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  if (fileStats.size <= 0) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件为空，无法发送: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  if (fileStats.size > MAX_FEISHU_UPLOAD_FILE_BYTES) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件过大，飞书当前只支持发送 30MB 以内文件: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  try {
    const fileBuffer = await fs.promises.readFile(resolvedTarget.filePath);
    await runtime.sendFileMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      fileName: path.basename(resolvedTarget.filePath),
      fileBuffer,
    });
    console.log(`[codex-im] file/send ok workspace=${workspaceRoot} path=${resolvedTarget.displayPath}`);
  } catch (error) {
    console.warn(
      `[codex-im] file/send failed workspace=${workspaceRoot} path=${resolvedTarget.displayPath}: ${error.message}`
    );
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("发送文件失败", error),
    });
  }
}

async function handleListCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
  if (!workspaceContext) {
    return;
  }
  const { workspaceRoot } = workspaceContext;

  const requestedPath = extractListPath(normalized.text);
  const resolvedTarget = resolveWorkspaceListTarget(workspaceRoot, requestedPath);
  if (resolvedTarget.errorText) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: resolvedTarget.errorText,
    });
    return;
  }

  let targetStats;
  try {
    targetStats = await fs.promises.stat(resolvedTarget.directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `目录不存在: ${resolvedTarget.displayPath}`,
      });
      return;
    }
    throw error;
  }

  if (!targetStats.isDirectory()) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `只支持列出目录，不支持文件: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  try {
    const entries = await fs.promises.readdir(resolvedTarget.directoryPath, { withFileTypes: true });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildDirectoryListText({
        workspaceRoot,
        displayPath: resolvedTarget.displayPath,
        entries,
      }),
    });
  } catch (error) {
    console.warn(
      `[codex-im] directory/list failed workspace=${workspaceRoot} path=${resolvedTarget.displayPath}: ${error.message}`
    );
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("列出目录失败", error),
    });
  }
}

async function handleModelCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawModel = extractModelValue(normalized.text);
  if (!rawModel) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: false,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const modelUpdateDirective = parseUpdateDirective(rawModel);
  if (modelUpdateDirective) {
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: true,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelListText(workspaceRoot, availableModelsResult, {
        refreshed: true,
      }),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, {
    settingType: "model",
  });
  if (!availableModelsResult) {
    return;
  }

  const resolvedModel = resolveRequestedModel(availableModelsResult.models, rawModel);
  if (!resolvedModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelValidationErrorText(workspaceRoot, rawModel, availableModelsResult.models),
    });
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: resolvedModel,
    effort: current.effort || "",
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置模型：${resolvedModel}`,
  });
}

async function handleEffortCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawEffort = extractEffortValue(normalized.text);
  if (!rawEffort) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: false,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, {
    settingType: "effort",
  });
  if (!availableModelsResult) {
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const effectiveModel = resolveEffectiveModelForEffort(availableModelsResult.models, current.model);
  if (!effectiveModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前无法确定模型，请先执行 `/codex model` 并设置模型后再设置推理强度。",
    });
    return;
  }

  const resolvedEffort = resolveRequestedEffort(effectiveModel, rawEffort);
  if (!resolvedEffort) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortValidationErrorText(workspaceRoot, effectiveModel, rawEffort),
    });
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: current.model || "",
    effort: resolvedEffort,
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置推理强度：${resolvedEffort}`,
  });
}

async function handleWorkspacesCommand(runtime, normalized, { replyToMessageId } = {}) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  if (!items.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还没有已绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildWorkspaceBindingsCard(items),
  });
}

async function showThreadPicker(runtime, normalized, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const threads = await runtime.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot) || threads[0]?.id || "";
  if (!threads.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: `当前项目：\`${workspaceRoot}\`\n\n还没有可切换的历史线程。`,
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildThreadPickerCard({
      workspaceRoot,
      threads,
      currentThreadId,
    }),
  });
}

async function handleRemoveCommand(runtime, normalized) {
  const workspaceRoot = extractRemoveWorkspacePath(normalized.text);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex remove /绝对路径`",
    });
    return;
  }

  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "路径必须是绝对路径。",
    });
    return;
  }

  await removeWorkspaceByPath(runtime, normalized, workspaceRoot, {
    replyToMessageId: normalized.messageId,
  });
}

async function switchWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "已经是当前项目，无需切换。",
    });
    return;
  }

  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，请先执行 `/codex bind /绝对路径`。",
    });
    return;
  }

  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, targetWorkspaceRoot);
  await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot: targetWorkspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  await handleWorkspacesCommand(runtime, normalized, {
    replyToMessageId: replyToMessageId || normalized.messageId,
  });
}

async function removeWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "当前项目不支持移除，请先切换到其他项目。",
    });
    return;
  }

  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，无需移除。",
    });
    return;
  }

  runtime.sessionStore.removeWorkspace(bindingKey, targetWorkspaceRoot);
  await handleWorkspacesCommand(runtime, normalized, {
    replyToMessageId: replyToMessageId || normalized.messageId,
  });
}

module.exports = {
  handleBindCommand,
  handleBuild8123Command,
  handleBuild2223Command,
  handleEffortCommand,
  handleHelpCommand,
  handleListCommand,
  handleMessageCommand,
  handleModelCommand,
  handleRemoveCommand,
  handleSendCommand,
  handleUnknownCommand,
  handleWhereCommand,
  handleWorkspacesCommand,
  removeWorkspaceByPath,
  resolveWorkspaceContext,
  showStatusPanel,
  showThreadPicker,
  switchWorkspaceByPath,
  validateDefaultCodexParamsConfig,
};

function buildNginxBuildSuccessText({ port, projectName, targetRoot, previousRoot, changed }) {
  const lines = [
    `已更新 ${port} 端口映射到项目：\`${projectName}\``,
    `当前 root：\`${targetRoot}\``,
  ];
  if (changed && previousRoot && previousRoot !== targetRoot) {
    lines.splice(1, 0, `旧 root：\`${previousRoot}\``);
  }
  lines.push("", "已执行 `nginx -t -c /usr/local/etc/nginx/nginx.conf` 和 `nginx -s reload -c /usr/local/etc/nginx/nginx.conf`。");
  return lines.join("\n");
}

async function updateNginxProjectRootAndReload({ port, projectName }) {
  const normalizedProjectName = String(projectName || "").trim();
  validateProjectName(normalizedProjectName);

  const targetRoot = path.join(NGINX_APPS_ROOT, normalizedProjectName, "dist");
  await ensureDirectoryExists(targetRoot, {
    missingText: `项目 dist 目录不存在: ${targetRoot}`,
    invalidText: `项目 dist 路径不是目录: ${targetRoot}`,
  });

  const originalConfig = await fs.promises.readFile(NGINX_CONFIG_PATH, "utf8");
  const updateResult = updateNginxRootForPort(originalConfig, port, targetRoot);
  const shouldWrite = updateResult.updatedConfig !== originalConfig;

  if (shouldWrite) {
    await fs.promises.writeFile(NGINX_CONFIG_PATH, updateResult.updatedConfig, "utf8");
  }

  try {
    await runNginxCommand(["-t", "-c", NGINX_CONFIG_PATH], "nginx 配置校验失败");
    await runNginxCommand(["-s", "reload", "-c", NGINX_CONFIG_PATH], "nginx 重载失败");
  } catch (error) {
    if (shouldWrite) {
      await restoreNginxConfig(originalConfig);
    }
    throw error;
  }

  return {
    port,
    projectName: normalizedProjectName,
    targetRoot,
    previousRoot: updateResult.previousRoot,
    changed: shouldWrite,
  };
}

async function ensureDirectoryExists(directoryPath, { missingText, invalidText }) {
  let stats;
  try {
    stats = await fs.promises.stat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(missingText);
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(invalidText);
  }
}

async function restoreNginxConfig(originalConfig) {
  try {
    await fs.promises.writeFile(NGINX_CONFIG_PATH, originalConfig, "utf8");
  } catch (error) {
    throw new Error(`回滚 Nginx 配置失败: ${error.message}`);
  }
}

async function runNginxCommand(args, failurePrefix) {
  try {
    await execFileAsync("nginx", args, { encoding: "utf8" });
  } catch (error) {
    const detail = formatExecFileError(error);
    throw new Error(detail ? `${failurePrefix}: ${detail}` : failurePrefix);
  }
}

function formatExecFileError(error) {
  const output = [
    typeof error?.stderr === "string" ? error.stderr.trim() : "",
    typeof error?.stdout === "string" ? error.stdout.trim() : "",
    typeof error?.message === "string" ? error.message.trim() : "",
  ].find(Boolean);
  return output || "";
}

function validateProjectName(projectName) {
  if (!projectName) {
    throw new Error("projectName 不能为空。");
  }
  if (!VALID_PROJECT_NAME_PATTERN.test(projectName)) {
    throw new Error("projectName 只允许字母、数字、点、下划线和中划线。");
  }
}

function updateNginxRootForPort(configText, port, targetRoot) {
  const sanitizedConfig = stripNginxComments(configText);
  const serverBlocks = findNginxBlocks(configText, sanitizedConfig, /^[ \t]*server\s*\{/gm);
  const matchedServerBlocks = serverBlocks.filter((block) => serverBlockListensOnPort(block.sanitizedContent, port));

  if (!matchedServerBlocks.length) {
    throw new Error(`未找到 listen ${port}; 对应的 server 配置。`);
  }
  if (matchedServerBlocks.length > 1) {
    throw new Error(`找到多个 listen ${port}; 的 server 配置，拒绝自动修改。`);
  }

  const matchedServerBlock = matchedServerBlocks[0];
  const updatedServerBlock = updateServerBlockRoot(matchedServerBlock, port, targetRoot);

  return {
    updatedConfig: [
      configText.slice(0, matchedServerBlock.start),
      updatedServerBlock.content,
      configText.slice(matchedServerBlock.end),
    ].join(""),
    previousRoot: updatedServerBlock.previousRoot,
  };
}

function updateServerBlockRoot(serverBlock, port, targetRoot) {
  const locationBlocks = findNginxBlocks(
    serverBlock.content,
    serverBlock.sanitizedContent,
    /^[ \t]*location[ \t]+\/[ \t]*\{/gm
  );
  if (locationBlocks.length > 1) {
    throw new Error(`listen ${port}; 的 server 配置中存在多个 location /，拒绝自动修改。`);
  }

  const targetBlock = locationBlocks[0] || {
    start: 0,
    end: serverBlock.content.length,
    content: serverBlock.content,
  };
  const updatedTargetBlock = replaceRootDirective(targetBlock.content, targetRoot);
  if (!updatedTargetBlock) {
    const scopeLabel = locationBlocks.length ? `listen ${port}; 的 location /` : `listen ${port}; 的 server`;
    throw new Error(`${scopeLabel} 中未找到 root 指令。`);
  }

  if (!locationBlocks.length) {
    return {
      content: updatedTargetBlock.content,
      previousRoot: updatedTargetBlock.previousRoot,
    };
  }

  return {
    content: [
      serverBlock.content.slice(0, targetBlock.start),
      updatedTargetBlock.content,
      serverBlock.content.slice(targetBlock.end),
    ].join(""),
    previousRoot: updatedTargetBlock.previousRoot,
  };
}

function replaceRootDirective(blockContent, targetRoot) {
  const rootMatch = /^([ \t]*root[ \t]+)([^;\n]+)(;[^\n]*)$/m.exec(blockContent);
  if (!rootMatch) {
    return null;
  }

  return {
    content: [
      blockContent.slice(0, rootMatch.index),
      rootMatch[1],
      targetRoot,
      rootMatch[3],
      blockContent.slice(rootMatch.index + rootMatch[0].length),
    ].join(""),
    previousRoot: rootMatch[2].trim(),
  };
}

function serverBlockListensOnPort(serverBlockText, port) {
  const listenPattern = new RegExp(`^[ \\t]*listen[ \\t]+${port}(?:[ \\t]+[^\\n;]+)?;`, "m");
  return listenPattern.test(serverBlockText);
}

function findNginxBlocks(sourceText, sanitizedText, openerPattern) {
  const blocks = [];
  const pattern = new RegExp(openerPattern.source, openerPattern.flags);
  let match = pattern.exec(sanitizedText);
  while (match) {
    const openBraceIndex = sanitizedText.indexOf("{", match.index);
    const closeBraceIndex = findMatchingBraceIndex(sanitizedText, openBraceIndex);
    if (closeBraceIndex < 0) {
      throw new Error("Nginx 配置存在未闭合的大括号。");
    }

    blocks.push({
      start: match.index,
      end: closeBraceIndex + 1,
      content: sourceText.slice(match.index, closeBraceIndex + 1),
      sanitizedContent: sanitizedText.slice(match.index, closeBraceIndex + 1),
    });

    pattern.lastIndex = closeBraceIndex + 1;
    match = pattern.exec(sanitizedText);
  }

  return blocks;
}

function findMatchingBraceIndex(text, openBraceIndex) {
  if (openBraceIndex < 0 || text[openBraceIndex] !== "{") {
    return -1;
  }

  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function stripNginxComments(text) {
  return String(text || "").replace(/#[^\n]*/g, (match) => " ".repeat(match.length));
}

function resolveWorkspaceListTarget(workspaceRoot, requestedPath) {
  const normalizedInput = normalizeWorkspacePath(requestedPath);
  if (!normalizedInput) {
    return {
      directoryPath: workspaceRoot,
      displayPath: ".",
    };
  }
  if (isAbsoluteWorkspacePath(normalizedInput)) {
    return { errorText: "只支持当前项目下的相对路径，不支持绝对路径。" };
  }

  const directoryPath = path.resolve(workspaceRoot, requestedPath);
  const normalizedResolvedPath = normalizeWorkspacePath(directoryPath);
  if (!pathMatchesWorkspaceRoot(normalizedResolvedPath, workspaceRoot)) {
    return { errorText: "目录路径超出了当前项目根目录。" };
  }

  return {
    directoryPath,
    displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, directoryPath)) || ".",
  };
}

function buildDirectoryListText({ workspaceRoot, displayPath, entries }) {
  const categorized = categorizeDirectoryEntries(entries);
  const totalCount = categorized.directories.length + categorized.files.length + categorized.others.length;
  const lines = [
    "**目录清单**",
    `项目根目录：\`${workspaceRoot}\``,
    `当前路径：\`${displayPath}\``,
    `共 ${totalCount} 项，目录 ${categorized.directories.length}，文件 ${categorized.files.length}，其他 ${categorized.others.length}`,
  ];

  if (!totalCount) {
    lines.push("", "该目录为空。");
    return lines.join("\n");
  }

  appendDirectoryListSection(lines, "目录", categorized.directories, { suffix: "/" });
  appendDirectoryListSection(lines, "文件", categorized.files);
  appendDirectoryListSection(lines, "其他", categorized.others, { suffix: "*" });

  return lines.join("\n");
}

function categorizeDirectoryEntries(entries) {
  const directories = [];
  const files = [];
  const others = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }
    if (entry.isDirectory()) {
      directories.push(name);
      continue;
    }
    if (entry.isFile()) {
      files.push(name);
      continue;
    }
    others.push(name);
  }

  const sortNames = (items) => items.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  sortNames(directories);
  sortNames(files);
  sortNames(others);

  return { directories, files, others };
}

function appendDirectoryListSection(lines, label, names, { suffix = "" } = {}) {
  if (!Array.isArray(names) || !names.length) {
    return;
  }

  const displayItems = names.slice(0, MAX_DIRECTORY_LIST_ITEMS_PER_GROUP);
  lines.push("", `${label}（${names.length}）`);
  for (const name of displayItems) {
    lines.push(`- \`${name}${suffix}\``);
  }
  if (displayItems.length < names.length) {
    lines.push(`- ... 还有 ${names.length - displayItems.length} 项未展示`);
  }
}

function resolveWorkspaceSendTarget(workspaceRoot, requestedPath) {
  const normalizedInput = normalizeWorkspacePath(requestedPath);
  if (!normalizedInput) {
    return { errorText: "用法: `/codex send <当前项目下的相对文件路径>`" };
  }
  if (isAbsoluteWorkspacePath(normalizedInput)) {
    return { errorText: "只支持当前项目下的相对路径，不支持绝对路径。" };
  }

  const filePath = path.resolve(workspaceRoot, requestedPath);
  const normalizedResolvedPath = normalizeWorkspacePath(filePath);
  if (!pathMatchesWorkspaceRoot(normalizedResolvedPath, workspaceRoot)) {
    return { errorText: "文件路径超出了当前项目根目录。" };
  }

  return {
    filePath,
    displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, filePath)) || path.basename(filePath),
  };
}

function parseUpdateDirective(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "update") {
    return { forceRefresh: true };
  }
  return null;
}

function applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot) {
  const current = runtime.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  if (current.model || current.effort) {
    return;
  }

  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const validatedDefaults = validateDefaultCodexParamsConfig(runtime, availableModels);
  const defaultModel = validatedDefaults.model;
  const defaultEffort = validatedDefaults.effort;
  if (!defaultModel && !defaultEffort) {
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: defaultModel,
    effort: defaultEffort,
  });
}

function validateDefaultCodexParamsConfig(runtime, modelsInput) {
  const models = Array.isArray(modelsInput) ? modelsInput : [];
  const rawModel = normalizeText(runtime.config.defaultCodexModel);
  const rawEffort = normalizeEffort(runtime.config.defaultCodexEffort);
  const result = { model: "", effort: "" };
  if (!rawModel && !rawEffort) {
    return result;
  }
  if (!models.length) {
    return result;
  }

  if (rawModel) {
    result.model = resolveRequestedModel(models, rawModel);
  }

  if (rawEffort) {
    const effectiveModel = resolveEffectiveModelForEffort(models, result.model || rawModel);
    if (effectiveModel) {
      result.effort = resolveRequestedEffort(effectiveModel, rawEffort);
    }
  }

  return result;
}

async function resolveCodexSettingWorkspaceContext(runtime, normalized) {
  return resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
}

function normalizeEffort(value) {
  return String(value || "").trim().toLowerCase();
}

async function loadAvailableModelsForSetting(runtime, normalized, { settingType }) {
  const availableModelsResult = await loadAvailableModels(runtime, {
    forceRefresh: false,
  });
  if (!availableModelsResult.error) {
    return availableModelsResult;
  }
  const isEffort = settingType === "effort";
  const actionLabel = isEffort ? "推理强度" : "模型";
  const listCommand = isEffort ? "/codex effort" : "/codex model";
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `无法设置${actionLabel}：${availableModelsResult.error}`,
      "",
      `请先执行 \`${listCommand}\`，确认可用${actionLabel}后重试。`,
    ].join("\n"),
  });
  return null;
}

async function loadAvailableModels(runtime, { forceRefresh = false } = {}) {
  const cached = runtime.sessionStore.getAvailableModelCatalog();
  if (!forceRefresh && cached?.models?.length) {
    return {
      models: cached.models,
      error: "",
      source: "cache",
      updatedAt: cached.updatedAt || "",
    };
  }

  try {
    const response = await runtime.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      if (cached?.models?.length) {
        return {
          models: cached.models,
          error: "",
          source: "cache",
          updatedAt: cached.updatedAt || "",
          warning: "Codex 未返回模型列表，已回退本地缓存。",
        };
      }
      return {
        models: [],
        error: "Codex 未返回可用模型列表。",
        source: forceRefresh ? "refresh" : "live",
        updatedAt: "",
      };
    }
    const saved = runtime.sessionStore.setAvailableModelCatalog(models);
    return {
      models,
      error: "",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: saved?.updatedAt || new Date().toISOString(),
    };
  } catch (error) {
    if (cached?.models?.length) {
      return {
        models: cached.models,
        error: "",
        source: "cache",
        updatedAt: cached.updatedAt || "",
        warning: `拉取失败，已回退本地缓存：${error?.message || "未知错误"}`,
      };
    }
    return {
      models: [],
      error: error?.message || "获取模型列表失败。",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: "",
    };
  }
}

function resolveRequestedModel(models, rawInput) {
  const matched = findModelByQuery(models, rawInput);
  return matched?.model || matched?.id || "";
}

function resolveRequestedEffort(modelEntry, rawEffort) {
  if (!modelEntry) {
    return "";
  }
  const query = normalizeEffort(rawEffort);
  if (!query) {
    return "";
  }
  const availableEfforts = listModelEfforts(modelEntry, { withDefaultFallback: true });
  for (const effort of availableEfforts) {
    if (normalizeEffort(effort) === query) {
      return effort;
    }
  }
  return "";
}

function buildModelSelectOptions(models) {
  if (!Array.isArray(models) || !models.length) {
    return [];
  }
  return models
    .map((item) => normalizeText(item?.model))
    .filter(Boolean)
    .slice(0, 100)
    .map((model) => ({
      label: model,
      value: model,
    }));
}

function buildEffortSelectOptions(models, currentModel) {
  const effectiveModel = resolveEffectiveModelForEffort(models, currentModel);
  if (!effectiveModel) {
    return [];
  }
  const supported = listModelEfforts(effectiveModel, { withDefaultFallback: true });
  const options = [];
  const seen = new Set();
  for (const effort of supported) {
    const normalized = normalizeText(effort);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      label: normalized,
      value: normalized,
    });
  }
  return options.slice(0, 20);
}

function listModelEfforts(modelEntry, { withDefaultFallback = false } = {}) {
  const supported = Array.isArray(modelEntry?.supportedReasoningEfforts)
    ? modelEntry.supportedReasoningEfforts
    : [];
  if (supported.length) {
    return supported;
  }
  if (!withDefaultFallback) {
    return [];
  }
  const defaultEffort = normalizeText(modelEntry?.defaultReasoningEffort);
  return defaultEffort ? [defaultEffort] : [];
}
