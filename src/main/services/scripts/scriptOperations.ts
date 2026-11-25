import type { MachineScriptsOperation } from "../../../shared/machineLink";
import type { ScriptService } from "../scripts";

/** One operation from the desktop on a machine's scripts. The operation
 *  arrived over the link, so its fields are checked before use. */
export async function handleScriptsOperation(service: ScriptService, operation: MachineScriptsOperation): Promise<unknown> {
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value) throw new Error(`The request has no ${field}.`);
    return value;
  };
  switch (operation.op) {
    case "list": return service.list();
    case "revision":
      return service.revisionContent(text(operation.scriptId, "script"), typeof operation.revisionId === "string" ? operation.revisionId : undefined);
    case "runs": return service.runs(text(operation.scriptId, "script"));
    case "setSecret": {
      const scriptId = text(operation.scriptId, "script");
      await service.setSecret(scriptId, text(operation.name, "key name"), text(operation.value, "key value"));
      return service.summary(scriptId);
    }
    case "deleteSecret": {
      const scriptId = text(operation.scriptId, "script");
      await service.deleteSecret(scriptId, text(operation.name, "key name"));
      return service.summary(scriptId);
    }
    case "setEnabled": {
      const scriptId = text(operation.scriptId, "script");
      if (typeof operation.enabled !== "boolean") throw new Error("The request does not say on or off.");
      await service.setEnabled(scriptId, operation.enabled);
      return service.summary(scriptId);
    }
    case "runNow": await service.runNow(text(operation.scriptId, "script")); return undefined;
    case "delete": await service.deleteScript(text(operation.scriptId, "script")); return undefined;
    case "releaseHeld": await service.releaseHeld(text(operation.scriptId, "script")); return undefined;
    case "discardHeld": await service.discardHeld(text(operation.scriptId, "script")); return undefined;
    default: {
      const unknown: never = operation;
      throw new Error(`This machine does not know the scheduled tasks operation ${(unknown as { op?: unknown }).op}; upgrade its runtime.`);
    }
  }
}
