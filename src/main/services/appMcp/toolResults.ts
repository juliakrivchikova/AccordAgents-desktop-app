import { APP_MCP_TOOL_POLICIES } from "../../../shared/appMcpToolContracts";

export function diagnosticToolName(params: unknown): string {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return "unknown-tool";
  }
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && APP_MCP_TOOL_POLICIES.some((policy) => policy.name === name)
    ? name
    : "unknown-tool";
}

export function structuredToolDenialCode(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const value = (item as { text?: unknown }).text;
    return typeof value === "string" ? [value] : [];
  })[0];
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { ok?: unknown }).ok !== false) {
      return undefined;
    }
    const error = (parsed as { error?: unknown }).error;
    const code = error && typeof error === "object" && !Array.isArray(error)
      ? (error as { code?: unknown }).code
      : undefined;
    return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(code)
      ? code
      : "APP_TOOL_REQUEST_DENIED";
  } catch {
    return undefined;
  }
}

export function appToolPolicyDenialCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/not allowed/i.test(message)) {
    return "APP_TOOL_CAPABILITY_DENIED";
  }
  if (/unauthorized/i.test(message)) {
    return "APP_TOOL_UNAUTHORIZED";
  }
  return undefined;
}

export function toolTextResult(result: unknown): unknown {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

export function toolImageResult(result: unknown): unknown {
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as { attachment?: unknown; dataBase64?: unknown }
    : {};
  const attachment = record.attachment && typeof record.attachment === "object" && !Array.isArray(record.attachment)
    ? record.attachment as { mimeType?: unknown }
    : undefined;
  const data = typeof record.dataBase64 === "string" ? record.dataBase64 : "";
  const mimeType = typeof attachment?.mimeType === "string" ? attachment.mimeType : "image/png";
  const summary = {
    ...record,
    dataBase64: data ? "[omitted: returned as MCP image content]" : undefined
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(summary, null, 2)
      },
      ...(data
        ? [{
            type: "image",
            data,
            mimeType
          }]
        : [])
    ]
  };
}
