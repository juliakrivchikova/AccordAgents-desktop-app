import { useCallback, useEffect, useRef, useState } from "react";

import { defaultImageFilename, formatBytes } from "./chat-format";

const CHAT_IMAGE_MAX_ATTACHMENTS = 5;
const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface PendingChatImage {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  objectUrl?: string;
  dataBase64?: string;
  status: "loading" | "ready" | "error";
  error?: string;
}

export function useChatComposerImages(conversationId: string | undefined): {
  addImageFiles: (files: File[]) => Promise<void>;
  hasInvalidImages: boolean;
  pendingImages: PendingChatImage[];
  readyImages: PendingChatImage[];
  removePendingImage: (imageId: string) => void;
  setPendingImages: React.Dispatch<React.SetStateAction<PendingChatImage[]>>;
} {
  const [pendingImages, setPendingImages] = useState<PendingChatImage[]>([]);
  const pendingImagesRef = useRef<PendingChatImage[]>([]);
  const readyImages = pendingImages.filter((image) => image.status === "ready" && image.dataBase64);
  const hasInvalidImages = pendingImages.some((image) => image.status !== "ready");

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => {
    setPendingImages((current) => {
      revokePendingImageUrls(current);
      return [];
    });
  }, [conversationId]);

  useEffect(() => {
    return () => {
      revokePendingImageUrls(pendingImagesRef.current);
    };
  }, []);

  const addImageFiles = useCallback(async (files: File[]): Promise<void> => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    const availableSlots = CHAT_IMAGE_MAX_ATTACHMENTS - pendingImages.length;
    if (availableSlots <= 0) {
      setPendingImages((current) => [...current, tooManyImagesError()]);
      return;
    }
    const acceptedFiles = imageFiles.slice(0, availableSlots);
    const overflow = imageFiles.length - acceptedFiles.length;
    const placeholders = acceptedFiles.map((file): PendingChatImage => {
      const validationError = pendingImageValidationError(file);
      return {
        id: crypto.randomUUID(),
        filename: file.name || defaultImageFilename(file.type),
        mimeType: file.type,
        sizeBytes: file.size,
        objectUrl: validationError ? undefined : URL.createObjectURL(file),
        status: validationError ? "error" : "loading",
        error: validationError
      };
    });
    setPendingImages((current) => [
      ...current,
      ...placeholders,
      ...(overflow > 0 ? [tooManyImagesError()] : [])
    ]);
    await Promise.all(placeholders.map(async (placeholder, index) => {
      if (placeholder.status === "error") {
        return;
      }
      try {
        const dataBase64 = await readFileAsBase64(acceptedFiles[index]);
        setPendingImages((current) => current.map((image) => image.id === placeholder.id
          ? { ...image, dataBase64, status: "ready" }
          : image
        ));
      } catch {
        setPendingImages((current) => current.map((image) => image.id === placeholder.id
          ? { ...image, status: "error", error: "Could not read this image." }
          : image
        ));
      }
    }));
  }, [pendingImages.length]);

  const removePendingImage = useCallback((imageId: string): void => {
    setPendingImages((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (removed?.objectUrl) {
        URL.revokeObjectURL(removed.objectUrl);
      }
      return current.filter((image) => image.id !== imageId);
    });
  }, []);

  return {
    addImageFiles,
    hasInvalidImages,
    pendingImages,
    readyImages,
    removePendingImage,
    setPendingImages
  };
}

export function revokePendingImageUrls(images: PendingChatImage[]): void {
  for (const image of images) {
    if (image.objectUrl) {
      URL.revokeObjectURL(image.objectUrl);
    }
  }
}

function tooManyImagesError(): PendingChatImage {
  return {
    id: crypto.randomUUID(),
    filename: "Too many images",
    mimeType: "",
    sizeBytes: 0,
    status: "error",
    error: `Attach at most ${CHAT_IMAGE_MAX_ATTACHMENTS} images.`
  };
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unable to read image."));
        return;
      }
      resolve(reader.result.replace(/^data:[^;]+;base64,/, ""));
    };
    reader.readAsDataURL(file);
  });
}

function pendingImageValidationError(file: File): string | undefined {
  if (!CHAT_IMAGE_ALLOWED_MIME_TYPES.has(file.type)) {
    return "Use PNG, JPEG, or WebP.";
  }
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return `Use images up to ${formatBytes(CHAT_IMAGE_MAX_BYTES)}.`;
  }
  return undefined;
}
