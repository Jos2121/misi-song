import { defineHandler } from "nitro";
import { readBody, createError, setResponseStatus } from "nitro/h3";
import { pool } from "../../../utils/db";
import { runFfmpeg, getFfmpegThreads, fetchWithTimeout } from "../../../utils/ffmpegQueue";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export default defineHandler(async (event) => {
  const body = await readBody(event);
  
  if (!body || !body.whatsappNumber) {
    throw createError({ statusCode: 400, statusMessage: "whatsappNumber is required" });
  }

  const { 
    plan,
    backgroundUrl, userPhotoUrl, titulo, artista, dedicatoria, whatsappNumber, config,
    paraQuien, ocasion, estiloMusical, cancionOriginal, tipoVoz, tono, nombreDedicado, historia 
  } = body;
  
  const cleanPhone = whatsappNumber.replace(/\+/g, '').replace(/\s/g, '');

  // 1. Buscamos el trabajo existente limpiando el número
  const result = await pool.query(
    `SELECT * FROM "MediaJob" 
     WHERE REPLACE(REPLACE("whatsappNumber", '+', ''), ' ', '') LIKE $1 
     ORDER BY "createdAt" DESC LIMIT 1`,
    [`%${cleanPhone}%`]
  );

  const job = result.rows[0];

  if (!job) {
    throw createError({ statusCode: 404, statusMessage: "Petición original no encontrada. Asegúrate de usar el mismo número de WhatsApp." });
  }

  // Generamos el nuevo prompt
  const promptGenerado = plan === 'especial'
    ? `[PLAN ESPECIAL - INSPIRADA EN CANCIÓN ORIGINAL]
1. ¿Para quién es?: ${paraQuien || ''}
2. Nombre de la persona dedicada: ${nombreDedicado || ''}
3. ¿Cuál es la ocasión?: ${ocasion || ''}
4. Canción original (título y autor o enlace de YouTube): ${cancionOriginal || ''}
5. Voz del cantante: ${tipoVoz || ''}
6. Cuéntanos su historia: ${historia || ''}`
    : `Actúa como un productor musical de talla mundial y un letrista galardonado. Tu objetivo es componer y producir una pista de calidad de estudio basada en los siguientes metadatos.

[DIRECCIÓN ACÚSTICA Y MUSICAL]
- Género y Estilo: ${estiloMusical}.
- Calidad de Producción: Alta fidelidad, mezcla estéreo inmersiva, instrumentación profesional, masterización estándar de radio.
- Atmósfera General: ${tono}.
- Pista Vocal: Voz ${tipoVoz}, interpretación profundamente emotiva, dicción cristalina, afinación perfecta, presencia frontal en la mezcla.

[CONTEXTO DE LA LETRA]
- Destinatario: ${paraQuien} (Nombre: ${nombreDedicado}).
- Ocasión / Motivo Central: ${ocasion}.
- Material Fuente (Nuestra Historia): "${historia}".

[DIRECTRICES DE COMPOSICIÓN]
1. Transformación Poética: Extrae los sentimientos, anécdotas y detalles del "Material Fuente" y conviértelos en metáforas visuales. No hagas un resumen o una lista de hechos; crea una declaración natural y emocional.
2. Sinergia Rítmica: Adapta la métrica de los versos para que fluya naturalmente con el tempo y los patrones rítmicos típicos del género ${estiloMusical}.
3. Estructura Obligatoria: Formatea la letra utilizando corchetes para guiar la generación musical. Debes incluir:
[Intro] (Establece el ambiente musical)
[Verse 1] (Introduce la historia de forma sutil)
[Pre-Chorus] (Construye la emoción)
[Chorus] (El clímax pegadizo que resalta el motivo de la canción)
[Verse 2] (Profundiza en un detalle específico de la historia)
[Chorus]
[Bridge] (Pico emocional y variación melódica)
[Chorus]
[Outro] (Cierre musical gradual)`;

  // Actualizamos el job existente sumando a generaciones y actualizando datos
  const updateResult = await pool.query(
    `UPDATE "MediaJob" 
     SET generaciones = COALESCE(generaciones, 0) + 1, 
         prompt = $2, 
         "userPhotoUrl" = $3, 
         "backgroundUrl" = $4,
         titulo = $5,
         artista = $6,
         dedicatoria = $7,
         config = $8,
         status = 'processing',
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      job.id,
      promptGenerado,
      userPhotoUrl || null,
      backgroundUrl || null,
      titulo || null,
      artista || null,
      dedicatoria || null,
      config ? JSON.stringify(config) : null
    ]
  );

  const updatedJob = updateResult.rows[0];

  // Responde INMEDIATAMENTE al frontend
  setResponseStatus(event, 202);
  
  // Start background process
  processJob(updatedJob).catch((err) => {
    console.error("Background processing failed for retry job:", updatedJob.id, err);
    pool.query(`UPDATE "MediaJob" SET status = 'error', "updatedAt" = NOW() WHERE id = $1`, [updatedJob.id]).catch(console.error);
  });

  return {
    ok: true,
    id: updatedJob.id,
    message: "Segundo intento en proceso",
    paymentWhatsappNumber: process.env.VITE_WHATSAPP_PAYMENT_NUMBER || process.env.WHATSAPP_PAYMENT_NUMBER || ''
  };
});

async function processJob(job: any) {
  const { id: jobId, titulo, artista, dedicatoria, userPhotoUrl, backgroundUrl, config, prompt } = job;

  // Ensure media dir exists
  const mediaDir = path.resolve(process.cwd(), "public/media");
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  // 2. GENERATE AUDIO via OpenRouter (Lyria)
  const lyriaPrompt = prompt || `Una canción titulada "${titulo || 'Sin Título'}" por ${artista || 'Artista Desconocido'} con la dedicatoria: ${dedicatoria || ''}`;
  
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  
  const model = process.env.OPENROUTER_MODEL || "google/lyria-3-pro-preview";
  const referer = process.env.NEXT_PUBLIC_APP_URL || "https://sings.inspiramkt.agency";

  let response;
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": referer,
          "X-Title": "Qustom Go"
        },
        body: JSON.stringify({
          model: model,
          modalities: ["text", "audio"],
          audio: { voice: "alloy", format: "mp3" },
          stream: true,
          messages: [{ role: "user", content: lyriaPrompt }]
        })
      }, 120000);

      if (response.ok) break;
      
      const errorText = await response.text();
      console.error(`OpenRouter Error Body (Attempt ${attempts}):`, errorText);
      if (attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 3000));
      else throw new Error("Failed to generate audio from OpenRouter");
    } catch (err: any) {
      if (attempts >= maxAttempts) throw err;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  if (!response || !response.body) throw new Error("No response body received from OpenRouter");

  let fullBase64Audio = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bufferStr = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bufferStr += decoder.decode(value, { stream: true });
      const lines = bufferStr.split("\n");
      bufferStr = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;

        try {
          const chunkJson = JSON.parse(trimmed.slice(6));
          const audioData = chunkJson.choices?.[0]?.delta?.audio?.data;
          if (audioData) fullBase64Audio += audioData;
        } catch (e) {
          // ignore parse errors for partial chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!fullBase64Audio) throw new Error("Stream ended without audio data");

  const audioBuffer = Buffer.from(fullBase64Audio, 'base64');
  const audioFileName = `audio_${Date.now()}.mp3`;
  const relativeAudioUrl = `/media/${audioFileName}`;
  const audioPath = path.join(mediaDir, audioFileName);
  
  fs.writeFileSync(audioPath, audioBuffer);

  await pool.query(
    `UPDATE "MediaJob" SET "audioUrl" = $1, status = 'audio_ready', "updatedAt" = NOW() WHERE id = $2`,
    [relativeAudioUrl, jobId]
  );

  // 3. GENERATE VIDEO via FFmpeg (Fase 1: Pre-composición estática + Fase 2: Video rápido)
  let tempPhotoPath = "";
  let downloadedTempPhoto = "";
  let tempBgPath = "";
  let tempTitlePath = "";
  let tempArtistPath = "";
  let tempDedPath = "";
  let tempComposedPath = "";
  let tempOverlayPath = "";

  try {
    const finalPhotoUrl = userPhotoUrl;
    const finalBgStr = backgroundUrl || 'image_f840ac.jpg';

    // Download user photo
    if (finalPhotoUrl) {
      if (finalPhotoUrl.startsWith('http')) {
        try {
          const imageRes = await fetchWithTimeout(finalPhotoUrl, {}, 20000);
          if (imageRes.ok) {
            downloadedTempPhoto = path.join(mediaDir, `temp_photo_${Date.now()}.jpg`);
            fs.writeFileSync(downloadedTempPhoto, Buffer.from(await imageRes.arrayBuffer()));
            tempPhotoPath = downloadedTempPhoto;
          }
        } catch (err) {
          console.warn("Error descargando foto en retry:", err);
        }
      }

      if (!tempPhotoPath) {
        const cleanImgName = path.basename(finalPhotoUrl.split('?')[0].split('#')[0]);
        const candidates = [
          path.join(mediaDir, cleanImgName),
          path.resolve(process.cwd(), "public", finalPhotoUrl.replace(/^\//, '')),
          path.resolve(process.cwd(), "public/media", cleanImgName),
          path.resolve(process.cwd(), "public/images", cleanImgName),
          path.resolve(process.cwd(), "public", cleanImgName),
          path.resolve(process.cwd(), "public/images/hero-cover.png")
        ];
        const found = candidates.find(p => fs.existsSync(p));
        if (found) {
          tempPhotoPath = found;
        } else {
          const fallback = path.resolve(process.cwd(), "public/images/hero-cover.png");
          if (fs.existsSync(fallback)) tempPhotoPath = fallback;
        }
      }
    }

    // Handle background
    const cleanBgName = path.basename(finalBgStr);
    let resolvedBgPath = path.join(mediaDir, cleanBgName);
    if (!fs.existsSync(resolvedBgPath)) {
      const altPath = path.resolve(process.cwd(), "public", finalBgStr.replace(/^\//, ''));
      if (fs.existsSync(altPath)) resolvedBgPath = altPath;
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
        tempBgPath = path.join(mediaDir, `temp_bg_${Date.now}${bgExt}`);
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

    const sanitizeText = (str: string) => {
      if (!str) return "";
      return str
        .replace(/:/g, "\\:")
        .replace(/'/g, "\u2019")
        .replace(/"/g, "\u201D");
    };

    const wrapTextForPreview = (str: string, fontSize: number, availableWidthPx: number = 860) => {
      if (!str) return "";
      const avgCharWidth = Math.max(12, fontSize * 0.52);
      const maxCharsPerLine = Math.max(16, Math.floor(availableWidthPx / avgCharWidth));

      const lines = str.split(/\r\n|\r|\n/);
      const finalLines: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          finalLines.push("");
          continue;
        }

        const words = trimmed.split(/\s+/);
        let currentLine = "";

        for (const word of words) {
          if (!currentLine) {
            currentLine = word;
          } else if ((currentLine + " " + word).length <= maxCharsPerLine) {
            currentLine += " " + word;
          } else {
            finalLines.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) {
          finalLines.push(currentLine);
        }
      }

      return finalLines.join("\n");
    };

    const t = config || {
      photo: { x: 130, y: 180, w: 820, h: 820, frame: true, angle: -3 },
      titulo: { x: 130, y: 1040, fontSize: 44, color: 'white', align: 'left', visible: true, angle: 0 },
      artista: { x: 130, y: 1100, fontSize: 32, color: '#B3B3B3', align: 'left', visible: true, angle: 0 },
      dedicatoria: { x: 540, y: 1620, fontSize: 30, color: '#E5E5E5', align: 'center', visible: true, angle: 0 },
      visualizer: { enabled: true, x: 130, y: 1180, w: 820, h: 70, color: '#FFFFFF' }
    };

    const sanitizeColor = (col?: string, defaultCol = 'white') => {
      if (!col) return defaultCol;
      return col.startsWith('#') ? col.replace('#', '0x') : col;
    };

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

    // Procesar Textos
    const isTituloVisible = t.titulo?.visible !== false && Boolean(titulo);
    const tituloAlign = t.titulo?.align || 'left';
    const tituloRawX = t.titulo?.x === 'center' || !t.titulo?.x ? 130 : Number(t.titulo.x);
    const tituloAvailableW = tituloAlign === 'center' ? 907 : Math.max(400, 993 - (tituloAlign === 'right' ? 86 : tituloRawX));
    const tituloSz = Number(t.titulo?.fontSize) || 44;
    const tituloY = Number(t.titulo?.y) || 1040;
    const tituloColor = sanitizeColor(t.titulo?.color, 'white');
    const tituloPos = tituloAlign === 'center' ? '(w-text_w)/2' : (tituloAlign === 'right' ? 'w-text_w-86' : `${tituloRawX}`);
    const tituloAlignFlag = tituloAlign === 'center' ? 'C' : (tituloAlign === 'right' ? 'R' : 'L');
    const tituloLineSpacing = Math.round(tituloSz * 0.25);

    if (isTituloVisible) {
      const formattedTitulo = wrapTextForPreview(sanitizeText(titulo), tituloSz, tituloAvailableW);
      tempTitlePath = path.join(mediaDir, `temp_tit_${Date.now()}.txt`);
      fs.writeFileSync(tempTitlePath, formattedTitulo, "utf8");
    }

    const isArtistaVisible = t.artista?.visible !== false && Boolean(artista);
    const artistaAlign = t.artista?.align || 'left';
    const artistaRawX = t.artista?.x === 'center' || !t.artista?.x ? 130 : Number(t.artista.x);
    const artistaAvailableW = artistaAlign === 'center' ? 907 : Math.max(400, 993 - (artistaAlign === 'right' ? 86 : artistaRawX));
    const artistaSz = Number(t.artista?.fontSize) || 32;
    const artistaY = Number(t.artista?.y) || 1100;
    const artistaColor = sanitizeColor(t.artista?.color, '0xB3B3B3');
    const artistaPos = artistaAlign === 'center' ? '(w-text_w)/2' : (artistaAlign === 'right' ? 'w-text_w-86' : `${artistaRawX}`);
    const artistaAlignFlag = artistaAlign === 'center' ? 'C' : (artistaAlign === 'right' ? 'R' : 'L');
    const artistaLineSpacing = Math.round(artistaSz * 0.25);

    if (isArtistaVisible) {
      const formattedArtista = wrapTextForPreview(sanitizeText(artista), artistaSz, artistaAvailableW);
      tempArtistPath = path.join(mediaDir, `temp_art_${Date.now()}.txt`);
      fs.writeFileSync(tempArtistPath, formattedArtista, "utf8");
    }

    const isDedicatoriaVisible = t.dedicatoria?.visible !== false && Boolean(dedicatoria);
    const dedicatoriaAlign = t.dedicatoria?.align || 'center';
    const dedicatoriaRawX = t.dedicatoria?.x === 'center' || !t.dedicatoria?.x ? 130 : Number(t.dedicatoria.x);
    const dedicatoriaAvailableW = dedicatoriaAlign === 'center' ? 907 : Math.max(400, 993 - (dedicatoriaAlign === 'right' ? 86 : dedicatoriaRawX));
    const dedicatoriaSz = Number(t.dedicatoria?.fontSize) || 30;
    const dedicatoriaY = Number(t.dedicatoria?.y) || 1620;
    const dedicatoriaColor = sanitizeColor(t.dedicatoria?.color, '0xE5E5E5');
    const dedicatoriaPos = dedicatoriaAlign === 'center' ? '(w-text_w)/2' : (dedicatoriaAlign === 'right' ? 'w-text_w-86' : `${dedicatoriaRawX}`);
    const dedicatoriaAlignFlag = dedicatoriaAlign === 'center' ? 'C' : (dedicatoriaAlign === 'right' ? 'R' : 'L');
    const dedicatoriaLineSpacing = Math.round(dedicatoriaSz * 0.25);

    if (isDedicatoriaVisible) {
      const formattedDedicatoria = wrapTextForPreview(sanitizeText(dedicatoria), dedicatoriaSz, dedicatoriaAvailableW);
      tempDedPath = path.join(mediaDir, `temp_ded_${Date.now()}.txt`);
      fs.writeFileSync(tempDedPath, formattedDedicatoria, "utf8");
    }

    // Parámetros de foto
    const photoW = Number(t.photo?.w) || 820;
    const photoH = Number(t.photo?.h) || 820;
    const photoX = Number(t.photo?.x) || 130;
    const photoY = Number(t.photo?.y) || 180;
    const photoAngle = Number(t.photo?.angle !== undefined ? t.photo.angle : -3);
    const hasPolaroidFrame = t.photo?.frame !== false;

    // FASE 1: PRE-COMPOSICIÓN ESTÁTICA
    const staticInputs: string[] = [];
    let photoInputIdx = -1;
    if (tempPhotoPath) {
      photoInputIdx = staticInputs.length;
      staticInputs.push(`-i "${tempPhotoPath}"`);
    }

    let staticFilter = "";
    if (!isVideoBg) {
      if (tempBgPath && fs.existsSync(tempBgPath)) {
        const bgIdx = staticInputs.length;
        staticInputs.push(`-i "${tempBgPath}"`);
        staticFilter += `[${bgIdx}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2[bg_base];`;
      } else {
        staticFilter += `color=c=black:s=1080x1920[bg_base];`;
      }
    } else {
      staticFilter += `color=c=black@0.0:s=1080x1920,format=rgba[bg_base];`;
    }

    let lastV = 'bg_base';
    let vIndex = 1;

    if (tempPhotoPath && photoInputIdx >= 0) {
      if (hasPolaroidFrame) {
        const padX = Math.round(photoW * 0.045);
        const padTop = Math.round(photoH * 0.045);
        const padBottom = Math.round(photoH * 0.17);
        const innerW = photoW - (padX * 2);
        const innerH = photoH - padTop - padBottom;

        staticFilter += `color=c=white:s=${photoW}x${photoH}[polaroid_card];`;
        staticFilter += `[${photoInputIdx}:v]scale=w=${innerW}:h=${innerH}:force_original_aspect_ratio=increase,crop=${innerW}:${innerH}:(in_w-${innerW})/2:(in_h-${innerH})/2[inner_photo];`;
        staticFilter += `[polaroid_card][inner_photo]overlay=x=${padX}:y=${padTop}[photo_raw];`;
      } else {
        staticFilter += `[${photoInputIdx}:v]scale=w=${photoW}:h=${photoH}:force_original_aspect_ratio=increase,crop=${photoW}:${photoH}:(in_w-${photoW})/2:(in_h-${photoH})/2[photo_raw];`;
      }

      staticFilter += `[photo_raw]format=rgba`;
      if (photoAngle !== 0) {
        const rad = `${photoAngle}*PI/180`;
        staticFilter += `,rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`;
      }
      staticFilter += `[photo_rot];`;
      staticFilter += `[photo_rot]split[p_shadow_in][p_front];`;
      staticFilter += `[p_shadow_in]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.55,gblur=sigma=16[photo_shadow];`;

      staticFilter += `[${lastV}][photo_shadow]overlay=x='${photoX}-(w-${photoW})/2+12':y='${photoY}-(h-${photoH})/2+20'[v_bg_s];`;
      staticFilter += `[v_bg_s][p_front]overlay=x='${photoX}-(w-${photoW})/2':y='${photoY}-(h-${photoH})/2'[v${vIndex}]`;
      lastV = `v${vIndex}`;
      vIndex++;
    }

    if (isTituloVisible && tempTitlePath) {
      const escapedTitlePath = tempTitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      staticFilter += `;[${lastV}]drawtext=textfile='${escapedTitlePath}'${fontParam}:fontcolor=${tituloColor}:fontsize=${tituloSz}:x=${tituloPos}:y=${tituloY}:text_align=${tituloAlignFlag}:line_spacing=${tituloLineSpacing}:shadowcolor=0x000000@0.55:shadowx=2:shadowy=2[v${vIndex}]`;
      lastV = `v${vIndex}`;
      vIndex++;
    }

    if (isArtistaVisible && tempArtistPath) {
      const escapedArtistPath = tempArtistPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      staticFilter += `;[${lastV}]drawtext=textfile='${escapedArtistPath}'${fontParam}:fontcolor=${artistaColor}:fontsize=${artistaSz}:x=${artistaPos}:y=${artistaY}:text_align=${artistaAlignFlag}:line_spacing=${artistaLineSpacing}:shadowcolor=0x000000@0.55:shadowx=2:shadowy=2[v${vIndex}]`;
      lastV = `v${vIndex}`;
      vIndex++;
    }

    if (isDedicatoriaVisible && tempDedPath) {
      const escapedDedPath = tempDedPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      staticFilter += `;[${lastV}]drawtext=textfile='${escapedDedPath}'${fontParam}:fontcolor=${dedicatoriaColor}:fontsize=${dedicatoriaSz}:x=${dedicatoriaPos}:y=${dedicatoriaY}:text_align=${dedicatoriaAlignFlag}:line_spacing=${dedicatoriaLineSpacing}:shadowcolor=0x000000@0.55:shadowx=2:shadowy=2[v${vIndex}]`;
      lastV = `v${vIndex}`;
      vIndex++;
    }

    const staticOutFileName = isVideoBg ? `temp_overlay_${Date.now()}.png` : `temp_composed_${Date.now()}.png`;
    const staticOutPath = path.join(mediaDir, staticOutFileName);
    if (isVideoBg) {
      tempOverlayPath = staticOutPath;
    } else {
      tempComposedPath = staticOutPath;
    }

    const staticInputsStr = staticInputs.length > 0 ? staticInputs.join(' ') : `-f lavfi -i color=c=black:s=1x1`;
    const staticCmd = `ffmpeg -y -threads 0 ${staticInputsStr} -filter_complex "${staticFilter}" -map "[${lastV}]" -vframes 1 "${staticOutPath}"`;
    await runFfmpeg(staticCmd, 60000);

    // FASE 2: CODIFICACIÓN DE VIDEO RÁPIDA
    const threads = getFfmpegThreads();
    const videoFileName = `video_${Date.now()}.mp4`;
    const videoPath = path.join(mediaDir, videoFileName);

    const vis = t.visualizer || { enabled: true, x: 130, y: 1180, w: 820, h: 70, color: 'white' };
    const isVisEnabled = vis.enabled !== false;
    const visW = Number(vis.w) || 820;
    const visH = Number(vis.h) || 70;
    const visX = vis.x === 'center' ? '(1080-w)/2' : (Number(vis.x) || 130);
    const visY = Number(vis.y) || 1180;
    const visColor = sanitizeColor(vis.color, 'white');

    let ffmpegCommand = "";

    if (!isVideoBg) {
      if (isVisEnabled) {
        const waveFilter = `[1:a]showwaves=s=${visW}x${visH}:mode=cline:colors=${visColor}:scale=sqrt,colorkey=0x000000:0.01:0.01,format=yuva420p[wave];[0:v][wave]overlay=x=${visX}:y=${visY}:shortest=1[v_out]`;
        ffmpegCommand = `ffmpeg -y -threads ${threads} -loop 1 -framerate 25 -i "${staticOutPath}" -i "${audioPath}" -filter_complex "${waveFilter}" -map "[v_out]" -map 1:a -c:v libx264 -preset veryfast -crf 26 -maxrate 2800k -bufsize 5600k -tune stillimage -c:a aac -b:a 160k -pix_fmt yuv420p -movflags +faststart -shortest "${videoPath}"`;
      } else {
        ffmpegCommand = `ffmpeg -y -threads ${threads} -loop 1 -framerate 25 -i "${staticOutPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 26 -maxrate 2800k -bufsize 5600k -tune stillimage -c:a aac -b:a 160k -pix_fmt yuv420p -movflags +faststart -shortest "${videoPath}"`;
      }
    } else {
      let videoFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2,fps=25[bg];[bg][1:v]overlay=shortest=1[v_comp]`;
      let finalV = 'v_comp';

      if (isVisEnabled) {
        videoFilter += `;[2:a]showwaves=s=${visW}x${visH}:mode=cline:colors=${visColor}:scale=sqrt,colorkey=0x000000:0.01:0.01,format=yuva420p[wave];[v_comp][wave]overlay=x=${visX}:y=${visY}[v_out]`;
        finalV = 'v_out';
      }

      ffmpegCommand = `ffmpeg -y -threads ${threads} -stream_loop -1 -i "${tempBgPath}" -loop 1 -framerate 25 -i "${staticOutPath}" -i "${audioPath}" -filter_complex "${videoFilter}" -map "[${finalV}]" -map 2:a -c:v libx264 -preset veryfast -crf 26 -maxrate 2800k -bufsize 5600k -c:a aac -b:a 160k -pix_fmt yuv420p -movflags +faststart -shortest "${videoPath}"`;
    }

    await runFfmpeg(ffmpegCommand);

    const relativeVideoUrl = `/media/${videoFileName}`;
    
    await pool.query(
      `UPDATE "MediaJob" SET "videoUrl" = $1, status = 'completed', "updatedAt" = NOW() WHERE id = $2`,
      [relativeVideoUrl, jobId]
    );
  } finally {
    const toClean = [
      downloadedTempPhoto,
      tempTitlePath,
      tempArtistPath,
      tempDedPath,
      tempComposedPath,
      tempOverlayPath
    ];

    if (tempBgPath && tempBgPath.includes('temp_bg_')) {
      toClean.push(tempBgPath);
    }

    for (const f of toClean) {
      if (f && fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (e) {}
      }
    }
  }
}
