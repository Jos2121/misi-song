import { defineHandler } from "nitro";
import { readMultipartFormData, createError } from "nitro/h3";
import fs from "node:fs/promises";
import path from "node:path";

export default defineHandler(async (event) => {
  const formData = await readMultipartFormData(event);
  
  if (!formData || formData.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "No file uploaded" });
  }

  // Find the file in the multipart form data
  const fileField = formData.find((field) => field.name === "file" || field.filename);

  if (!fileField || !fileField.data) {
    throw createError({ statusCode: 400, statusMessage: "No file found in request" });
  }

  // 100MB max limit to allow full HD live wallpaper videos
  const MAX_SIZE = 100 * 1024 * 1024;
  if (fileField.data.length > MAX_SIZE) {
    throw createError({ statusCode: 413, statusMessage: "El archivo supera el límite de 100MB" });
  }

  // Ensure public/media directory exists
  const publicMediaDir = path.join(process.cwd(), "public", "media");
  await fs.mkdir(publicMediaDir, { recursive: true }).catch(() => {});

  const originalName = fileField.filename || "";
  let ext = path.extname(originalName).toLowerCase();
  const mimeType = (fileField.type || "").toLowerCase();

  if (!ext) {
    if (mimeType.includes("video/mp4") || mimeType.includes("mp4")) {
      ext = ".mp4";
    } else if (mimeType.includes("video/webm") || mimeType.includes("webm")) {
      ext = ".webm";
    } else if (mimeType.includes("video/quicktime")) {
      ext = ".mov";
    } else if (mimeType.includes("image/png")) {
      ext = ".png";
    } else if (mimeType.includes("image/webp")) {
      ext = ".webp";
    } else if (mimeType.includes("image/gif")) {
      ext = ".gif";
    } else {
      ext = ".jpg";
    }
  }

  const isVideo = ext === ".mp4" || ext === ".webm" || ext === ".mov" || mimeType.startsWith("video/");
  const prefix = isVideo ? "video_bg_" : "cover_";
  const fileName = `${prefix}${Date.now()}${ext.startsWith(".") ? ext : `.${ext}`}`;
  const filePath = path.join(publicMediaDir, fileName);

  await fs.writeFile(filePath, fileField.data);

  return {
    url: `/media/${fileName}`,
    fileName,
    isVideo
  };
});
