import { defineHandler } from "nitro";
import { readBody, createError } from "nitro/h3";
import { pool, ensureSchema } from "../../../utils/db";
import { runFfmpeg, getFfmpegThreads, fetchWithTimeout } from "../../../utils/ffmpegQueue";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export default defineHandler(async (event) => {
  const body = await readBody(event);
  
  const { jobId, backgroundUrl, userPhotoUrl, imageUrl, titulo, artista, dedicatoria, templateConfig } = body;

  if (!jobId || (!userPhotoUrl && !imageUrl)) {
    throw createError({ statusCode: 400, statusMessage: "jobId and either userPhotoUrl or imageUrl are required" });
  }

  await ensureSchema();

  // 1. Obtener información del trabajo
  const result = await pool.query('SELECT * FROM "MediaJob" WHERE id = $1', [jobId]);
  const job = result.rows[0];

  if (!job || !job.audioUrl) {
    throw createError({ statusCode: 400, statusMessage: "Falta generar o subir el audio primero." });
  }

  // 2. Localizar archivos y descargar imagen
  const mediaDir = path.resolve(process.cwd(), "public/media");
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  const audioPath = path.join(mediaDir, path.basename(job.audioUrl));

  if (!fs.existsSync(audioPath)) {
    throw createError({ statusCode: 400, statusMessage: "Audio file not found on disk" });
  }

  let finalImagePath = "";
  let tempImagePath = "";
  let tempBgPath = "";
  let tempTitlePath = "";
  let tempArtistPath = "";
  let tempDedPath = "";
  
  try {
    const targetImage = userPhotoUrl || imageUrl;
    const finalBgStr = backgroundUrl || 'image_f840ac.jpg';

    if (!targetImage) {
      throw createError({ statusCode: 400, statusMessage: "No image provided" });
    }

    if (targetImage.startsWith("http")) {
      // Es una URL externa: descargarla
      try {
        const imageRes = await fetchWithTimeout(targetImage, {}, 20000);
        if (imageRes.ok) {
          const arrayBuffer = await imageRes.arrayBuffer();
          tempImagePath = path.join(mediaDir, `temp_photo_${Date.now()}.jpg`);
          fs.writeFileSync(tempImagePath, Buffer.from(arrayBuffer));
          finalImagePath = tempImagePath;
        }
      } catch (err) {
        console.warn("Error descargando imagen externa:", err);
      }
    } else if (targetImage.startsWith("data:image/")) {
      // Es una imagen en base64 (subida local en el frontend)
      const matches = targetImage.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        tempImagePath = path.join(mediaDir, `temp_photo_${Date.now()}.${ext}`);
        fs.writeFileSync(tempImagePath, buffer);
        finalImagePath = tempImagePath;
      } else {
        throw createError({ statusCode: 400, statusMessage: "Invalid base64 image format" });
      }
    }

    if (!finalImagePath) {
      // Búsqueda inteligente de archivo local
      const cleanImgName = path.basename(targetImage.split('?')[0].split('#')[0]);
      const candidates = [
        path.join(mediaDir, cleanImgName),
        path.resolve(process.cwd(), "public", targetImage.replace(/^\//, '')),
        path.resolve(process.cwd(), "public/media", cleanImgName),
        path.resolve(process.cwd(), "public/images", cleanImgName),
        path.resolve(process.cwd(), "public", cleanImgName),
        path.resolve(process.cwd(), "public/images/hero-cover.png")
      ];

      const foundPath = candidates.find(p => fs.existsSync(p));
      if (foundPath) {
        finalImagePath = foundPath;
      } else {
        const fallbackImg = path.resolve(process.cwd(), "public/images/hero-cover.png");
        if (fs.existsSync(fallbackImg)) {
          finalImagePath = fallbackImg;
        } else {
          throw createError({ statusCode: 404, statusMessage: "Local image file not found on disk" });
        }
      }
    }

    // Handle background (download if URL, otherwise check local file)
    const cleanBgName = path.basename(finalBgStr);
    let resolvedBgPath = path.join(mediaDir, cleanBgName);
    if (!fs.existsSync(resolvedBgPath)) {
      const altPath = path.resolve(process.cwd(), "public", finalBgStr.replace(/^\//, ''));
      if (fs.existsSync(altPath)) {
        resolvedBgPath = altPath;
      }
    }

    if (finalBgStr.startsWith('http')) {
      const bgRes = await fetchWithTimeout(finalBgStr, {}, 30000);
      if (bgRes.ok) {
        const bgUrlPath = finalBgStr.split('?')[0].split('#')[0];
        let bgExt = path.extname(bgUrlPath).toLowerCase();
        if (!bgExt) {
          const ctype = (bgRes.headers.get('content-type') || '').toLowerCase();
          bgExt = ctype.includes('video') ? '.mp4' : '.jpg';
        }
        tempBgPath = path.join(mediaDir, `temp_bg_${Date.now()}${bgExt}`);
        fs.writeFileSync(tempBgPath, Buffer.from(await bgRes.arrayBuffer()));
      }
    } else if (fs.existsSync(resolvedBgPath)) {
      tempBgPath = resolvedBgPath;
    }

    const isVideoBg = Boolean(
      tempBgPath && (
        tempBgPath.toLowerCase().endsWith('.mp4') ||
        tempBgPath.toLowerCase().endsWith('.webm') ||
        tempBgPath.toLowerCase().endsWith('.mov') ||
        finalBgStr.toLowerCase().includes('.mp4') ||
        finalBgStr.toLowerCase().includes('.webm')
      )
    );

    // 3. Ejecutar FFmpeg
    const videoFileName = `video_${Date.now()}.mp4`;
    const videoPath = path.join(mediaDir, videoFileName);
    
    let ffmpegCommand = "";

    // Si tenemos templateConfig o datos, construimos dinámicamente el complexFilter
    if (templateConfig || titulo || artista || dedicatoria || backgroundUrl || userPhotoUrl) {
      const sanitize = (str: string) => {
        if (!str) return "";
        return str.replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/"/g, "\u201D").replace(/[\n\r]/g, " ");
      };
      
      const wrapText = (str: string, maxCharsPerLine = 34) => {
        if (!str) return "";
        const words = str.trim().split(/\s+/);
        let lines: string[] = [];
        let currentLine = "";
        for (const word of words) {
          if ((currentLine + " " + word).trim().length <= maxCharsPerLine) {
            currentLine = (currentLine + " " + word).trim();
          } else {
            if (currentLine) lines.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) lines.push(currentLine);
        return lines.join("\\n");
      };

      const safeTitulo = sanitize(titulo);
      const safeArtista = sanitize(artista);
      const escapedDedicatoria = wrapText(sanitize(dedicatoria));

      const t = templateConfig || {
        photo: { x: 130, y: 180, w: 820, h: 820, frame: true },
        titulo: { x: 130, y: 1040, fontSize: 44, color: 'white', align: 'left', visible: true },
        artista: { x: 130, y: 1100, fontSize: 32, color: '#B3B3B3', align: 'left', visible: true },
        dedicatoria: { x: 'center', y: 1620, fontSize: 30, color: '#E5E5E5', align: 'center', visible: true }
      };

      const sanitizeColor = (col?: string, defaultCol = 'white') => {
        if (!col) return defaultCol;
        return col.startsWith('#') ? col.replace('#', '0x') : col;
      };

      // Extracción de parámetros numéricos desde el body o la config
      const dedicatoriaX = t.dedicatoria?.x !== 'center' ? (Number(t.dedicatoria?.x) || 540) : 540;
      const dedicatoriaY = Number(t.dedicatoria?.y) || Number(body.dedicatoriaY) || 1620;
      const dedicatoriaSize = Number(t.dedicatoria?.fontSize) || Number(body.dedicatoriaSize) || 30;
      const dedicatoriaColor = sanitizeColor(t.dedicatoria?.color, '0xE5E5E5');

      const photoW = Number(t.photo?.w) || 820;
      const photoH = Number(t.photo?.h) || 820;
      const photoX = Number(t.photo?.x) || 130;
      const photoY = Number(t.photo?.y) || 180;
      const hasPolaroidFrame = t.photo?.frame !== false;

      const bgInput = tempBgPath
        ? (isVideoBg ? `-stream_loop -1 -i "${tempBgPath}"` : `-loop 1 -framerate 1 -i "${tempBgPath}"`)
        : `-f lavfi -i color=c=black:s=1080x1920:r=1`;

      // Escala del fondo sin deformarlo (crop centrado al formato vertical 1080x1920) y normaliza a 25fps
      let filter = `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2,fps=25[bg_base];`;

      if (hasPolaroidFrame) {
        // Marco Polaroid blanco con espacio extendido en la parte inferior
        const padX = Math.round(photoW * 0.045);
        const padTop = Math.round(photoH * 0.045);
        const padBottom = Math.round(photoH * 0.17);
        const innerW = photoW - (padX * 2);
        const innerH = photoH - padTop - padBottom;

        filter += `color=c=white:s=${photoW}x${photoH}:d=1,fps=25[polaroid_card];`;
        filter += `[0:v]scale=w=${innerW}:h=${innerH}:force_original_aspect_ratio=increase,crop=${innerW}:${innerH}:(in_w-${innerW})/2:(in_h-${innerH})/2,fps=25[inner_photo];`;
        filter += `[polaroid_card][inner_photo]overlay=x=${padX}:y=${padTop}[photo];`;
      } else {
        // Recorte dinámico basado en las dimensiones de la foto
        filter += `[0:v]scale=w=${photoW}:h=${photoH}:force_original_aspect_ratio=increase,crop=${photoW}:${photoH}:(in_w-${photoW})/2:(in_h-${photoH})/2[photo];`;
      }

      // Overlay foto en fondo
      filter += `[bg_base][photo]overlay=x=${photoX}:y=${photoY}[v1]`;

      let lastV = 'v1';
      let vIndex = 2;

      // Visualización musical de la canción (showwaves)
      const vis = t.visualizer || { enabled: true, x: 130, y: 1180, w: 820, h: 70, color: 'white' };
      if (vis.enabled !== false) {
        const visW = Number(vis.w) || 820;
        const visH = Number(vis.h) || 70;
        const visX = vis.x === 'center' ? '(1080-w)/2' : (Number(vis.x) || 130);
        const visY = Number(vis.y) || 1180;
        const rawColor = vis.color || 'white';
        const visColor = rawColor.startsWith('#') ? rawColor.replace('#', '0x') : rawColor;

        filter += `;[2:a]showwaves=s=${visW}x${visH}:mode=cline:colors=${visColor}:scale=sqrt,colorkey=0x000000:0.1:0.1,format=yuva420p[wave]`;
        filter += `;[${lastV}][wave]overlay=x=${visX}:y=${visY}[v${vIndex}]`;
        lastV = `v${vIndex}`;
        vIndex++;
      }
      
      let currentDir = "";
      try {
        currentDir = path.dirname(fileURLToPath(import.meta.url));
      } catch (e) {
        currentDir = process.cwd();
      }

      const fontCandidates = [
        path.join(mediaDir, "font_cursive.ttf"),
        path.resolve(currentDir, "../../../../public/fonts/cursive.ttf"),
        path.resolve(currentDir, "../../../public/fonts/cursive.ttf"),
        path.resolve(currentDir, "../../public/fonts/cursive.ttf"),
        path.resolve(currentDir, "../public/fonts/cursive.ttf"),
        path.resolve(currentDir, "./public/fonts/cursive.ttf"),
        path.resolve(process.cwd(), "public/fonts/cursive.ttf"),
        path.resolve(process.cwd(), "App Cursea/public/fonts/cursive.ttf"),
        path.resolve(process.cwd(), ".output/public/fonts/cursive.ttf"),
        path.resolve(process.cwd(), "App Cursea/.output/public/fonts/cursive.ttf"),
        "C:/Windows/Fonts/segoesc.ttf",
        "C:/Windows/Fonts/segoepr.ttf"
      ];
      const resolvedFont = fontCandidates.find(f => fs.existsSync(f)) || "C:/Windows/Fonts/segoesc.ttf";

      const guaranteedFontPath = path.join(mediaDir, "font_cursive.ttf");
      if (!fs.existsSync(guaranteedFontPath) && fs.existsSync(resolvedFont)) {
        try {
          fs.copyFileSync(resolvedFont, guaranteedFontPath);
        } catch (e) {
          console.warn("No se pudo copiar font a mediaDir:", e);
        }
      }

      const finalFontFile = fs.existsSync(guaranteedFontPath) ? guaranteedFontPath : resolvedFont;
      const escapedFontPath = finalFontFile.replace(/\\/g, '/').replace(/:/g, '\\:');
      const fontParam = `:fontfile='${escapedFontPath}'`;

      if (t.titulo?.visible !== false && safeTitulo) {
        const align = t.titulo?.align || 'left';
        const xPos = align === 'center' ? '(w-text_w)/2' : (align === 'right' ? 'w-text_w-86' : (t.titulo?.x || 130));
        const col = sanitizeColor(t.titulo?.color, 'white');
        const sz = Number(t.titulo?.fontSize) || 44;
        const yPos = Number(t.titulo?.y) || 1040;

        const tempTitleFileName = `temp_tit_${Date.now()}.txt`;
        tempTitlePath = path.join(mediaDir, tempTitleFileName);
        fs.writeFileSync(tempTitlePath, safeTitulo, "utf8");
        const escapedTitlePath = tempTitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');

        filter += `;[${lastV}]drawtext=textfile='${escapedTitlePath}'${fontParam}:fontcolor=${col}:fontsize=${sz}:x=${xPos}:y=${yPos}[v${vIndex}]`;
        lastV = `v${vIndex}`;
        vIndex++;
      }
      
      if (t.artista?.visible !== false && safeArtista) {
        const align = t.artista?.align || 'left';
        const xPos = align === 'center' ? '(w-text_w)/2' : (align === 'right' ? 'w-text_w-86' : (t.artista?.x || 130));
        const col = sanitizeColor(t.artista?.color, '0xB3B3B3');
        const sz = Number(t.artista?.fontSize) || 32;
        const yPos = Number(t.artista?.y) || 1100;

        const tempArtistFileName = `temp_art_${Date.now()}.txt`;
        tempArtistPath = path.join(mediaDir, tempArtistFileName);
        fs.writeFileSync(tempArtistPath, safeArtista, "utf8");
        const escapedArtistPath = tempArtistPath.replace(/\\/g, '/').replace(/:/g, '\\:');

        filter += `;[${lastV}]drawtext=textfile='${escapedArtistPath}'${fontParam}:fontcolor=${col}:fontsize=${sz}:x=${xPos}:y=${yPos}[v${vIndex}]`;
        lastV = `v${vIndex}`;
        vIndex++;
      }
      
      if (t.dedicatoria?.visible !== false && escapedDedicatoria) {
        const align = t.dedicatoria?.align || 'center';
        const xPos = align === 'center' ? '(w-text_w)/2' : (align === 'right' ? 'w-text_w-86' : (t.dedicatoria?.x || 130));
        const col = sanitizeColor(t.dedicatoria?.color || dedicatoriaColor, '0xE5E5E5');
        const sz = Number(t.dedicatoria?.fontSize) || dedicatoriaSize || 30;
        const yCoord = Number(t.dedicatoria?.y) || dedicatoriaY || 1620;

        const tempDedFileName = `temp_ded_${Date.now()}.txt`;
        tempDedPath = path.join(mediaDir, tempDedFileName);
        // Escribe las líneas reales en UTF-8 para renderizado perfecto de acentos y saltos de línea
        fs.writeFileSync(tempDedPath, escapedDedicatoria.replace(/\\n/g, "\n"), "utf8");
        const escapedDedPath = tempDedPath.replace(/\\/g, '/').replace(/:/g, '\\:');

        filter += `;[${lastV}]drawtext=textfile='${escapedDedPath}'${fontParam}:fontcolor=${col}:fontsize=${sz}:x=${xPos}:y=${yCoord}:line_spacing=${Math.round(sz * 0.4)}[v${vIndex}]`;
        lastV = `v${vIndex}`;
        vIndex++;
      }

      const threads = getFfmpegThreads();
      const tuneFlag = isVideoBg ? "" : "-tune stillimage";
      ffmpegCommand = `ffmpeg -y -threads ${threads} -loop 1 -framerate 1 -i "${finalImagePath}" ${bgInput} -i "${audioPath}" -filter_complex "${filter}" -map "[${lastV}]" -map 2:a -c:v libx264 -preset ultrafast ${tuneFlag} -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${videoPath}"`;

    } else {
      // Comportamiento fallback
      const threads = getFfmpegThreads();
      ffmpegCommand = `ffmpeg -y -threads ${threads} -loop 1 -framerate 1 -i "${finalImagePath}" -i "${audioPath}" -c:v libx264 -preset ultrafast -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${videoPath}"`;
    }

    await runFfmpeg(ffmpegCommand);

    // 4. Actualizar base de datos
    const relativeVideoUrl = `/media/${videoFileName}`;
    await pool.query(
      'UPDATE "MediaJob" SET "videoUrl" = $1, "status" = $2, "backgroundUrl" = $3, "userPhotoUrl" = $4, "titulo" = $5, "artista" = $6, "dedicatoria" = $7, "generaciones" = COALESCE("generaciones", 0) + 1 WHERE id = $8',
      [relativeVideoUrl, 'completed', backgroundUrl, userPhotoUrl, titulo, artista, dedicatoria, jobId]
    );

    return { success: true, videoUrl: relativeVideoUrl };

  } catch (error: any) {
    console.error("Video processing error:", error);
    await pool.query('UPDATE "MediaJob" SET "status" = $1 WHERE id = $2', ['error', jobId]);
    throw createError({ statusCode: 500, statusMessage: error.message || "Error processing video" });
  } finally {
    // Limpieza de archivos temporales
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      fs.unlinkSync(tempImagePath);
    }
    if (tempBgPath && tempBgPath.includes('temp_bg_') && fs.existsSync(tempBgPath)) {
      fs.unlinkSync(tempBgPath);
    }
    if (tempTitlePath && fs.existsSync(tempTitlePath)) {
      fs.unlinkSync(tempTitlePath);
    }
    if (tempArtistPath && fs.existsSync(tempArtistPath)) {
      fs.unlinkSync(tempArtistPath);
    }
    if (tempDedPath && fs.existsSync(tempDedPath)) {
      fs.unlinkSync(tempDedPath);
    }
  }
});
