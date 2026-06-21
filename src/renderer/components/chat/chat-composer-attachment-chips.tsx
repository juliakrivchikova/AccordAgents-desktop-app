import { FileText, ImagePlus, ListChecks, X } from "lucide-react";

import type {
  ChatSkillMention,
  RepoFileMention
} from "../../../shared/types";
import { providerLabel } from "./chat-conversation-data";
import { formatBytes } from "./chat-format";
import type { PendingChatImage } from "./use-chat-composer-images";

export function ChatComposerAttachmentChips(props: {
  pendingImages: PendingChatImage[];
  removeFileMention: (filePath: string) => void;
  removePendingImage: (imageId: string) => void;
  removeSkillMention: (mention: ChatSkillMention) => void;
  selectedFileMentions: RepoFileMention[];
  selectedSkillMentions: ChatSkillMention[];
}): JSX.Element {
  return (
    <>
      {props.selectedSkillMentions.length > 0 && (
        <div className="file-mention-chips skill-mention-chips" aria-label="Selected skills">
          {props.selectedSkillMentions.map((mention) => (
            <button type="button" onClick={() => props.removeSkillMention(mention)} key={mention.skillId}>
              <ListChecks size={14} />
              <span>{mention.displayName}</span>
              <small>{mention.variants.map((variant) => providerLabel(variant.providerKind)).join(", ")}</small>
              <X size={13} />
            </button>
          ))}
        </div>
      )}
      {props.selectedFileMentions.length > 0 && (
        <div className="file-mention-chips" aria-label="Referenced repository files">
          {props.selectedFileMentions.map((mention) => (
            <button type="button" onClick={() => props.removeFileMention(mention.path)} key={mention.path}>
              <FileText size={14} />
              <span>{mention.path}</span>
              <X size={13} />
            </button>
          ))}
        </div>
      )}
      {props.pendingImages.length > 0 && (
        <div className="pending-image-strip" aria-label="Pending image attachments">
          {props.pendingImages.map((image) => (
            <div className={`pending-image-item ${image.status}`} key={image.id}>
              {image.objectUrl ? (
                <img src={image.objectUrl} alt="" />
              ) : (
                <ImagePlus size={18} aria-hidden />
              )}
              <div>
                <strong>{image.filename}</strong>
                <span>{image.error ?? `${formatBytes(image.sizeBytes)}${image.status === "loading" ? " · reading" : ""}`}</span>
              </div>
              <button type="button" aria-label={`Remove ${image.filename}`} onClick={() => props.removePendingImage(image.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
