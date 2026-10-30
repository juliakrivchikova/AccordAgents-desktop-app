import { createContext } from "react";

/** Set inside a thread, so a file or attachment opened from it can come back to it. */
export const FilePanelOriginContext = createContext<{ threadRootId?: string }>({});

/**
 * Set around a message's content. A member on a cloud machine writes paths on
 * that machine; the User's computer does not have them, so its file links show
 * as text that says so instead of opening a local copy (User, 2026-10-30).
 */
export const FileLinkAuthorContext = createContext<{ cloud: boolean }>({ cloud: false });

export const CLOUD_FILE_LINK_TITLE = "This file is on the member's cloud machine, not on this computer. Ask them to send it as an artifact or an image.";

/** Opens an attached image in the side panel; absent where there is no panel (the image opens in a dialog). */
export const AttachmentPanelContext = createContext<{
  openAttachment?: (target: { attachmentId: string; filename: string; dataUrl: string; description?: string; returnThreadRootId?: string }) => void;
}>({});
