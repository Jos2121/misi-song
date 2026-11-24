import { defineHandler } from "nitro";
import { readBody, createError } from "nitro/h3";
import { pool, ensureSchema } from "../../../utils/db";
import { runFfmpeg, getFfmpegThreads, fetchWithTimeout } from "../../../utils/ffmpegQueue";
import { generateVisualizerVideo } from "../../../utils/visualizer";
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
  let finalPergaminoPath = "";
  let tempPergaminoPath = "";
  let tempComposedPath = "";
  let tempOverlayPath = "";
  let tempVisPath = "";
  
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

    // 3. Resolver configuración de plantilla
    const t = templateConfig || (job?.config ? (typeof job.config === 'string' ? JSON.parse(job.config) : job.config) : null) || {
      photo: { x: 130, y: 180, w: 820, h: 820, frame: true, angle: -3 },
      pergamino: { url: '', x: 130, y: 1040, w: 820, h: 380, angle: 0, visible: true },
      titulo: { x: 130, y: 1040, fontSize: 44, color: 'white', align: 'left', visible: true, angle: 0 },
      artista: { x: 130, y: 1100, fontSize: 32, color: '#B3B3B3', align: 'left', visible: true, angle: 0 },
      dedicatoria: { x: 540, y: 1620, fontSize: 30, color: '#E5E5E5', align: 'center', visible: true, angle: 0 },
      visualizer: { enabled: true, x: 130, y: 1180, w: 820, h: 70, color: '#FFFFFF' }
    };

    // Funciones de formateo y sincronización de texto idéntico a VideoEditorPreview
    const sanitizeText = (str: string) => {
      if (!str) return "";
      return str
        .replace(/:/g, "\\:")
        .replace(/'/g, "\u2019")
        .replace(/"/g, "\u201D");
    };

    // Wrapping respetando saltos de línea explícitos y ajustando al ancho disponible en px
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

    const sanitizeColor = (col?: string, defaultCol = 'white') => {
      if (!col) return defaultCol;
      return col.startsWith('#') ? col.replace('#', '0x') : col;
    };

    // Localizar pergamino si existe
    const targetPergamino = body.pergaminoUrl || t.pergamino?.url;
    if (targetPergamino && t.pergamino?.visible !== false) {
      if (targetPergamino.startsWith("http")) {
        try {
          const pRes = await fetchWithTimeout(targetPergamino, {}, 20000);
          if (pRes.ok) {
            tempPergaminoPath = path.join(mediaDir, `temp_perg_${Date.now()}.png`);
            fs.writeFileSync(tempPergaminoPath, Buffer.from(await pRes.arrayBuffer()));
            finalPergaminoPath = tempPergaminoPath;
          }
        } catch (e) {
          console.warn("Error descargando pergamino:", e);
        }
      } else if (targetPergamino.startsWith("data:image/")) {
        const matches = targetPergamino.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          tempPergaminoPath = path.join(mediaDir, `temp_perg_${Date.now()}.png`);
          fs.writeFileSync(tempPergaminoPath, Buffer.from(matches[2], 'base64'));
          finalPergaminoPath = tempPergaminoPath;
        }
      } else {
        const cleanPName = path.basename(targetPergamino.split('?')[0].split('#')[0]);
        const pCandidates = [
          path.join(mediaDir, cleanPName),
          path.resolve(process.cwd(), "public", targetPergamino.replace(/^\//, '')),
          path.resolve(process.cwd(), "public/media", cleanPName)
        ];
        const foundP = pCandidates.find(p => fs.existsSync(p));
        if (foundP) {
          finalPergaminoPath = foundP;
        }
      }
    }

    // Ubicación de fuente cursive
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

    // Procesar Textos: Título, Artista (Frase) y Dedicatoria
    const isTituloVisible = t.titulo?.visible !== false && Boolean(titulo);
    const tituloAlign = (t.titulo?.align || 'left') as 'left' | 'center' | 'right';
    const tituloRawX = t.titulo?.x === 'center' || !t.titulo?.x ? 130 : Number(t.titulo.x);
    const tituloAvailableW = tituloAlign === 'center' ? 907 : Math.max(400, 993 - (tituloAlign === 'right' ? 86 : tituloRawX));
    const tituloSz = Number(t.titulo?.fontSize) || 44;
    const tituloY = Number(t.titulo?.y) || 1040;
    const tituloColor = sanitizeColor(t.titulo?.color, 'white');
    const tituloAngle = Number(t.titulo?.angle) || 0;
    let formattedTitulo = "";

    if (isTituloVisible) {
      formattedTitulo = wrapTextForPreview(sanitizeText(titulo), tituloSz, tituloAvailableW);
      tempTitlePath = path.join(mediaDir, `temp_tit_${Date.now()}.txt`);
      fs.writeFileSync(tempTitlePath, formattedTitulo, "utf8");
    }

    const isArtistaVisible = t.artista?.visible !== false && Boolean(artista);
    const artistaAlign = (t.artista?.align || 'left') as 'left' | 'center' | 'right';
    const artistaRawX = t.artista?.x === 'center' || !t.artista?.x ? 130 : Number(t.artista.x);
    const artistaAvailableW = artistaAlign === 'center' ? 907 : Math.max(400, 993 - (artistaAlign === 'right' ? 86 : artistaRawX));
    const artistaSz = Number(t.artista?.fontSize) || 32;
    const artistaY = Number(t.artista?.y) || 1100;
    const artistaColor = sanitizeColor(t.artista?.color, '0xB3B3B3');
    const artistaAngle = Number(t.artista?.angle) || 0;
    let formattedArtista = "";

    if (isArtistaVisible) {
      formattedArtista = wrapTextForPreview(sanitizeText(artista), artistaSz, artistaAvailableW);
      tempArtistPath = path.join(mediaDir, `temp_art_${Date.now()}.txt`);
      fs.writeFileSync(tempArtistPath, formattedArtista, "utf8");
    }

    const isDedicatoriaVisible = t.dedicatoria?.visible !== false && Boolean(dedicatoria);
    const dedicatoriaAlign = (t.dedicatoria?.align || 'center') as 'left' | 'center' | 'right';
    const dedicatoriaRawX = t.dedicatoria?.x === 'center' || !t.dedicatoria?.x ? 130 : Number(t.dedicatoria.x);
    const dedicatoriaAvailableW = dedicatoriaAlign === 'center' ? 907 : Math.max(400, 993 - (dedicatoriaAlign === 'right' ? 86 : dedicatoriaRawX));
    const dedicatoriaSz = Number(t.dedicatoria?.fontSize) || Number(body.dedicatoriaSize) || 30;
    const dedicatoriaY = Number(t.dedicatoria?.y) || Number(body.dedicatoriaY) || 1620;
    const dedicatoriaColor = sanitizeColor(t.dedicatoria?.color, '0xE5E5E5');
    const dedicatoriaAngle = Number(t.dedicatoria?.angle) || 0;
    let formattedDedicatoria = "";

    if (isDedicatoriaVisible) {
      formattedDedicatoria = wrapTextForPreview(sanitizeText(dedicatoria), dedicatoriaSz, dedicatoriaAvailableW);
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

    // FASE 1: PRE-COMPOSICIÓN ESTÁTICA EN 1 SOLO FOTOGRAMA
    // Compone foto con marco polaroid, rotación, sombra difusa, pergamino y todos los textos en 1 pasada rápida de 0.2s.
    // Esto evita evaluar gblur, rotaciones, drawtext y múltiples overlays en cada uno de los 4,500 frames del video.
    const staticInputs: string[] = [];
    staticInputs.push(`-i "${finalImagePath}"`); // [0:v] foto
    
    let staticFilter = "";
    let nextInputIdx = 1;

    if (!isVideoBg) {
      if (tempBgPath && fs.existsSync(tempBgPath)) {
        staticInputs.push(`-i "${tempBgPath}"`); // [1:v] fondo estático
        staticFilter += `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2[bg_base];`;
        nextInputIdx++;
      } else {
        staticFilter += `color=c=black:s=1080x1920[bg_base];`;
      }
    } else {
      // Para fondo en video, el lienzo de la composición es un PNG transparente de 1080x1920
      staticFilter += `color=c=black@0.0:s=1080x1920,format=rgba[bg_base];`;
    }

    if (hasPolaroidFrame) {
      const padX = Math.round(photoW * 0.045);
      const padTop = Math.round(photoH * 0.045);
      const padBottom = Math.round(photoH * 0.17);
      const innerW = photoW - (padX * 2);
      const innerH = photoH - padTop - padBottom;

      staticFilter += `color=c=white:s=${photoW}x${photoH}[polaroid_card];`;
      staticFilter += `[0:v]scale=w=${innerW}:h=${innerH}:force_original_aspect_ratio=increase,crop=${innerW}:${innerH}:(in_w-${innerW})/2:(in_h-${innerH})/2[inner_photo];`;
      staticFilter += `[polaroid_card][inner_photo]overlay=x=${padX}:y=${padTop}[photo_raw];`;
    } else {
      staticFilter += `[0:v]scale=w=${photoW}:h=${photoH}:force_original_aspect_ratio=increase,crop=${photoW}:${photoH}:(in_w-${photoW})/2:(in_h-${photoH})/2[photo_raw];`;
    }

    staticFilter += `[photo_raw]format=rgba`;
    if (photoAngle !== 0) {
      const rad = `${photoAngle}*PI/180`;
      staticFilter += `,rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none`;
    }
    staticFilter += `[photo_rot];`;

    // Sombra difusa
    staticFilter += `[photo_rot]split[p_shadow_in][p_front];`;
    staticFilter += `[p_shadow_in]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.55,gblur=sigma=16[photo_shadow];`;

    staticFilter += `[bg_base][photo_shadow]overlay=x='${photoX}-(w-${photoW})/2+12':y='${photoY}-(h-${photoH})/2+20'[v_bg_s];`;
    staticFilter += `[v_bg_s][p_front]overlay=x='${photoX}-(w-${photoW})/2':y='${photoY}-(h-${photoH})/2'[v1]`;

    let lastV = 'v1';
    let vIndex = 2;

    // Pergamino estático
    if (finalPergaminoPath && t.pergamino?.visible !== false) {
      const pergIdx = nextInputIdx++;
      staticInputs.push(`-i "${finalPergaminoPath}"`);
      const pergW = Number(t.pergamino?.w) || 820;
      const pergH = Number(t.pergamino?.h) || 380;
      const pergX = Number(t.pergamino?.x) || 130;
      const pergY = Number(t.pergamino?.y) || 1040;
      const pergAngle = Number(t.pergamino?.angle) || 0;

      let pergFilter = `[${pergIdx}:v]scale=${pergW}:${pergH},format=rgba`;
      if (pergAngle !== 0) {
        const pRad = `${pergAngle}*PI/180`;
        pergFilter += `,rotate=${pRad}:ow='rotw(${pRad})':oh='roth(${pRad})':c=none`;
      }
      pergFilter += `[perg_layer];`;
      staticFilter += `;` + pergFilter;
      staticFilter += `[${lastV}][perg_layer]overlay=x='${pergX}-(w-${pergW})/2':y='${pergY}-(h-${pergH})/2'[v${vIndex}]`;
      lastV = `v${vIndex}`;
      vIndex++;
    }

    // Helper para renderizar texto con su ángulo e inclinación exacta idéntica a VideoEditorPreview
    const appendTextLayer = (opts: {
      key: string;
      tempPath: string;
      color: string;
      fontSize: number;
      y: number;
      align: 'left' | 'center' | 'right';
      rawX: number;
      angle: number;
      formattedText: string;
    }) => {
      const escapedPath = opts.tempPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const lineSpacing = Math.round(opts.fontSize * 0.25);
      const alignFlag = opts.align === 'center' ? 'C' : (opts.align === 'right' ? 'R' : 'L');
      const pos = opts.align === 'center' ? '(w-text_w)/2' : (opts.align === 'right' ? 'w-text_w-86' : `${opts.rawX}`);
      
      const lineCount = Math.max(1, opts.formattedText.split('\n').length);
      const lineHeightPx = Math.round(opts.fontSize * 1.25);
      const boxH = Math.max(lineHeightPx, lineCount * lineHeightPx);

      // Si no tiene ángulo, dibuja directo en la coordenada Y exacta
      if (!opts.angle || opts.angle === 0) {
        staticFilter += `;[${lastV}]drawtext=textfile='${escapedPath}'${fontParam}:fontcolor=${opts.color}:fontsize=${opts.fontSize}:x=${pos}:y=${opts.y}:text_align=${alignFlag}:line_spacing=${lineSpacing}:shadowcolor=0x000000@0.55:shadowx=2:shadowy=2[v${vIndex}]`;
        lastV = `v${vIndex}`;
        vIndex++;
        return;
      }

      // Si tiene ángulo, la caja tiene la altura justa del texto en CSS y el texto empieza en y=0
      const boxW = opts.align === 'left' ? Math.max(300, 993 - opts.rawX) : 907;
      const inBoxX = opts.align === 'center' ? '(w-text_w)/2' : (opts.align === 'right' ? 'w-text_w' : '0');
      const rad = (opts.angle * Math.PI) / 180;

      let overlayPos = "";
      if (opts.align === 'center') {
        overlayPos = `x=(1080-w)/2:y='${opts.y}+(${boxH}-h)/2'`;
      } else if (opts.align === 'left') {
        const offsetX = Math.round((boxW / 2) * Math.cos(rad));
        const offsetY = Math.round((boxW / 2) * Math.sin(rad));
        overlayPos = `x='${opts.rawX} + ${offsetX} - w/2':y='${Math.round(opts.y + boxH / 2)} + ${offsetY} - h/2'`;
      } else {
        const offsetX = Math.round((boxW / 2) * Math.cos(rad));
        const offsetY = Math.round((boxW / 2) * Math.sin(rad));
        overlayPos = `x='${1080 - 86} - ${offsetX} - w/2':y='${Math.round(opts.y + boxH / 2)} - ${offsetY} - h/2'`;
      }

      // y=0 dentro de la caja asegura que no haya desfase hacia abajo
      staticFilter += `;color=c=black@0.0:s=${boxW}x${boxH},format=rgba,drawtext=textfile='${escapedPath}'${fontParam}:fontcolor=${opts.color}:fontsize=${opts.fontSize}:x=${inBoxX}:y=0:text_align=${alignFlag}:line_spacing=${lineSpacing}:shadowcolor=0x000000@0.55:shadowx=2:shadowy=2[box_${opts.key}];[box_${opts.key}]rotate=${rad}:ow='rotw(${rad})':oh='roth(${rad})':c=none[rot_${opts.key}];[${lastV}][rot_${opts.key}]overlay=${overlayPos}[v${vIndex}]`;
      lastV = `v${vIndex}`;
      vIndex++;
    };

    // Textos con drawtext exacto, rotación respetada y sombra sutil
    if (isTituloVisible && tempTitlePath) {
      appendTextLayer({
        key: 'tit',
        tempPath: tempTitlePath,
        color: tituloColor,
        fontSize: tituloSz,
        y: tituloY,
        align: tituloAlign,
        rawX: tituloRawX,
        angle: tituloAngle,
        formattedText: formattedTitulo
      });
    }

    if (isArtistaVisible && tempArtistPath) {
      appendTextLayer({
        key: 'art',
        tempPath: tempArtistPath,
        color: artistaColor,
        fontSize: artistaSz,
        y: artistaY,
        align: artistaAlign,
        rawX: artistaRawX,
        angle: artistaAngle,
        formattedText: formattedArtista
      });
    }

    if (isDedicatoriaVisible && tempDedPath) {
      appendTextLayer({
        key: 'ded',
        tempPath: tempDedPath,
        color: dedicatoriaColor,
        fontSize: dedicatoriaSz,
        y: dedicatoriaY,
        align: dedicatoriaAlign,
        rawX: dedicatoriaRawX,
        angle: dedicatoriaAngle,
        formattedText: formattedDedicatoria
      });
    }

    // Generar la imagen pre-compuesta (1 solo fotograma)
    const staticOutFileName = isVideoBg ? `temp_overlay_${Date.now()}.png` : `temp_composed_${Date.now()}.png`;
    const staticOutPath = path.join(mediaDir, staticOutFileName);
    if (isVideoBg) {
      tempOverlayPath = staticOutPath;
    } else {
      tempComposedPath = staticOutPath;
    }

    const staticCmd = `ffmpeg -y -threads 0 ${staticInputs.join(' ')} -filter_complex "${staticFilter}" -map "[${lastV}]" -vframes 1 "${staticOutPath}"`;
    await runFfmpeg(staticCmd, 60000);

    // FASE 2: CODIFICACIÓN DEL VIDEO COMPLETO A MÁXIMA VELOCIDAD
    // Ahora el render de video solo tiene 1 capa estática + la onda de audio opcional.
    const threads = getFfmpegThreads();
    const videoFileName = `video_${Date.now()}.mp4`;
    const videoPath = path.join(mediaDir, videoFileName);

    const vis = t.visualizer || { enabled: true, x: 130, y: 1180, w: 820, h: 70, color: 'white' };
    const isVisEnabled = vis.enabled !== false;
    const visW = Number(vis.w) || 820;
    const visH = Number(vis.h) || 70;
    const resolvedVisX = vis.x === 'center' ? Math.round((1080 - visW) / 2) : (Number(vis.x) || 130);
    const resolvedVisY = Number(vis.y) || 1180;

    // Normalizar color: respetar exactamente el color de la vista previa (hex o nombre)
    const rawColor = vis.color || '#FFFFFF';
    const cleanVisColor = rawColor.startsWith('#')
      ? rawColor
      : (rawColor.startsWith('0x') ? rawColor.replace('0x', '#') : rawColor);

    if (isVisEnabled) {
      tempVisPath = path.join(mediaDir, `temp_vis_${Date.now()}.mov`);
      await generateVisualizerVideo(tempVisPath, {
        w: visW,
        h: visH,
        color: cleanVisColor,
        durationSeconds: 4,
        fps: 25
      });
    }

    let ffmpegCommand = "";

    if (!isVideoBg) {
      // Caso 1: Fondo es imagen estática (o color)
      // Animación de barras musicales idéntica a VideoEditorPreview (cápsulas redondeadas y brillo)
      if (isVisEnabled) {
        const waveFilter = `[0:v][1:v]overlay=x=${resolvedVisX}:y=${resolvedVisY}:shortest=1[v_out]`;
        ffmpegCommand = `ffmpeg -y -threads ${threads} -loop 1 -framerate 25 -i "${staticOutPath}" -stream_loop -1 -i "${tempVisPath}" -i "${audioPath}" -filter_complex "${waveFilter}" -map "[v_out]" -map 2:a -c:v libx264 -preset veryfast -crf 26 -maxrate 2800k -bufsize 5600k -c:a aac -b:a 160k -pix_fmt yuv420p -movflags +faststart -shortest "${videoPath}"`;
      } else {
        ffmpegCommand = `ffmpeg -y -threads ${threads} -loop 1 -framerate 25 -i "${staticOutPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v libx264 -preset veryfast -crf 26 -maxrate 2800k -bufsize 5600k -tune stillimage -c:a aac -b:a 160k -pix_fmt yuv420p -movflags +faststart -shortest "${videoPath}"`;
      }
    } else {
      // Caso 2: Fondo es Video MP4 (Live Wallpaper)
      if (isVisEnabled) {
        const videoFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2,fps=25[bg];[bg][1:v]overlay=shortest=1[v_comp];[v_comp][2:v]overlay=x=${resolvedVisX}:y=${resolvedVisY}[v_out]`;
        ffmpegCommand = `ffmpeg -y -threads ${threads} -stream_loop -1 -i "${tempBgPath}" -loop 1 -framerate 25 -i "${staticOutPath}" -stream_loop -1 -i "${tempVisPath}" -i "${audioPath}" -filter_complex "${videoFilter}" -map "[v_out]" -map 3:a -c:v libx264 -preset veryfast -crf 26 -maxrate 2800k -bufsize 5600k -c:a aac -b:a 160k -pix_fmt yuv420p -movflags +faststart -shortest "${videoPath}"`;
      } else {
        const videoFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2,fps=25[bg];[bg][1:v]overlay=shortest=1[v_out]`;
        ffmpegCommand = `ffmpeg -y -threads ${threads} -stream_loop -1 -i "${tempBgPath}" -loop 1 -framerate 25 -i "${staticOutPath}" -i "${audioPath}" -filter_complex "${videoFilter}" -map "[v_out]" -map 2:a -c:v libx264 -preset veryfast -crf 26 -maxrate 2800k -bufsize 5600k -c:a aac -b:a 160k -pix_fmt yuv420p -movflags +faststart -shortest "${videoPath}"`;
      }
    }

    await runFfmpeg(ffmpegCommand);

    // 4. Actualizar base de datos
    const relativeVideoUrl = `/media/${videoFileName}`;
    await pool.query(
      'UPDATE "MediaJob" SET "videoUrl" = $1, "status" = $2, "backgroundUrl" = $3, "userPhotoUrl" = $4, "titulo" = $5, "artista" = $6, "dedicatoria" = $7, "config" = COALESCE($8, "config"), "generaciones" = COALESCE("generaciones", 0) + 1 WHERE id = $9',
      [relativeVideoUrl, 'completed', backgroundUrl, userPhotoUrl, titulo, artista, dedicatoria, t ? JSON.stringify(t) : null, jobId]
    );

    return { success: true, videoUrl: relativeVideoUrl };

  } catch (error: any) {
    console.error("Video processing error:", error);
    await pool.query('UPDATE "MediaJob" SET "status" = $1 WHERE id = $2', ['error', jobId]);
    throw createError({ statusCode: 500, statusMessage: error.message || "Error processing video" });
  } finally {
    // Limpieza exhaustiva de archivos temporales
    const toClean = [
      tempImagePath,
      tempTitlePath,
      tempArtistPath,
      tempDedPath,
      tempPergaminoPath,
      tempComposedPath,
      tempOverlayPath,
      tempVisPath
    ];

    if (tempBgPath && tempBgPath.includes('temp_bg_')) {
      toClean.push(tempBgPath);
    }

    for (const f of toClean) {
      if (f && fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (e) {
          console.warn("No se pudo eliminar archivo temporal:", f, e);
        }
      }
    }
  }
});