import type { ChatDependencies } from "../dependencies";
import type { ChatModules } from "../modules";

// The parts of a chat service as its tests set them up and watch them: their
// private members too, so a test names the part that does the work.
type Open<T> = { [Key in keyof T]-?: any };

export function chatParts(service: unknown): Open<ChatModules> {
  return (service as { modules: Open<ChatModules> }).modules;
}

/** What that service was given; one object, shared by every part. */
export function chatDependencies(service: unknown): Open<ChatDependencies> {
  return chatParts(service).store.deps as Open<ChatDependencies>;
}
