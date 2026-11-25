import { hostPlatform } from "../../../platform";
import type { AgentEnvironmentValueProtection } from "../../../../shared/types";
import type { StoredAgentEnvironmentVariable } from "../types";

/** Seals what must not sit in the settings file as plain text. */
export class Secrets {
  encodeAgentEnvironmentValue(value: string): { encryptedValue: string; protection: AgentEnvironmentValueProtection } {
    if (this.safeStorageEncryptionAvailable()) {
      return {
        encryptedValue: hostPlatform().secrets.encryptString(value).toString("base64"),
        protection: "os-encrypted"
      };
    }
    return {
      encryptedValue: Buffer.from(value, "utf8").toString("base64"),
      protection: "local-obfuscated"
    };
  }

  decodeAgentEnvironmentValue(variable: StoredAgentEnvironmentVariable): string | undefined {
    try {
      const buffer = Buffer.from(variable.encryptedValue, "base64");
      if (variable.protection === "os-encrypted") {
        if (!this.safeStorageEncryptionAvailable()) {
          return undefined;
        }
        return hostPlatform().secrets.decryptString(buffer);
      }
      return buffer.toString("utf8");
    } catch {
      return undefined;
    }
  }

  safeStorageEncryptionAvailable(): boolean {
    return hostPlatform().secrets.isEncryptionAvailable();
  }

  // Machine pairings carry the key of a machine's first hello, so they are
  // stored sealed or not at all; the format is marked so a later read never
  // guesses.
  sealJson(json: string): string {
    const secrets = hostPlatform().secrets;
    if (!secrets.isEncryptionAvailable()) {
      throw new Error("Machine enrollments need the system secret store, which is not available on this computer.");
    }
    return `sealed:${secrets.encryptString(json).toString("base64")}`;
  }

  openJson(stored: string): string {
    const secrets = hostPlatform().secrets;
    if (stored.startsWith("sealed:")) {
      if (!secrets.isEncryptionAvailable()) {
        throw new Error("Machine enrollments are sealed with the system secret store, which is not available on this computer.");
      }
      return secrets.decryptString(Buffer.from(stored.slice("sealed:".length), "base64"));
    }
    // Records written before the format marker: sealed when a store existed,
    // otherwise plain base64.
    const buffer = Buffer.from(stored, "base64");
    if (secrets.isEncryptionAvailable()) {
      try {
        return secrets.decryptString(buffer);
      } catch {
        return buffer.toString("utf8");
      }
    }
    return buffer.toString("utf8");
  }
}
