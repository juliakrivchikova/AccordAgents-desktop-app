import type { ChatAttachmentImportSourceRoot } from "../types";

export interface ChatAttachmentImportSource {
  realPath: string;
  root: ChatAttachmentImportSourceRoot;
  dev: number;
  ino: number;
}
