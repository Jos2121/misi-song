import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export interface VisualizerOptions {
  durationSeconds?: number;
  fps?: number;
  w?: number;
  h?: number;
  color?: string;
}

const HEIGHTS = [
  25, 45, 65, 35, 75, 90, 50, 75, 100, 85, 45, 65, 80, 95, 70, 50,
  85, 100, 65, 45, 70, 95, 80, 55, 85, 90, 60, 40, 75, 85, 50, 65,
  40, 60, 35, 50, 30, 20
];

function parseColorToRgb(colorStr?: string): { r: number; g: number; b: number } {
  if (!colorStr) return { r: 255, g: 255, b: 255 };
  const c = colorStr.trim().toLowerCase();
  if (c === "white") return { r: 255, g: 255, b: 255 };
  if (c === "black") return { r: 0, g: 0, b: 0 };
  if (c === "red") return { r: 255, g: 0, b: 0 };
  if (c === "blue") return { r: 0, g: 102, b: 255 };
  if (c === "green") return { r: 0, g: 204, b: 102 };
  if (c === "yellow") return { r: 255, g: 204, b: 0 };
  
  const hex = c.replace(/^0x/, "").replace(/^#/, "");
  if (hex.length === 6) {
    return {
      r: parseInt(hex.substring(0, 2), 16) || 255,
      g: parseInt(hex.substring(2, 4), 16) || 255,
      b: parseInt(hex.substring(4, 6), 16) || 255,
    };
  } else if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16) || 255,
      g: parseInt(hex[1] + hex[1], 16) || 255,
      b: parseInt(hex[2] + hex[2], 16) || 255,
    };
  }
  return { r: 255, g: 255, b: 255 };
}

/**
 * Genera un clip de video transparente (.mov con PNG lossless) que reproduce la animación
 * de barras musicales con bordes redondeados (cápsulas), modulación de opacidad y brillo sutil,
 * idéntica a la vista previa de VideoEditorPreview.
 *
 * Utiliza períodos enteros para garantizar un bucle infinito 100% continuo y fluido (sin saltos).
 */
export function generateVisualizerVideo(
  outputPath: string,
  options?: VisualizerOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const durationSeconds = options?.durationSeconds || 4;
    const fps = options?.fps || 25;
    const W = Math.max(50, Math.round(Number(options?.w) || 820));
    const H = Math.max(20, Math.round(Number(options?.h) || 70));
    const { r: rCol, g: gCol, b: bCol } = parseColorToRgb(options?.color);

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const totalFrames = durationSeconds * fps;
    const numBars = HEIGHTS.length;
    const barW = Math.max(3, Math.floor(W / (numBars * 1.6)));
    const totalBarsW = numBars * barW;
    const gap = (W - totalBarsW) / (numBars - 1);
    const r = barW / 2;
    const cy = H / 2;
    const glowRadius = 3;
    const frameSize = W * H * 4;

    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "-s", `${W}x${H}`,
      "-r", `${fps}`,
      "-i", "-",
      "-c:v", "png",
      outputPath
    ]);

    let spawnErr: Error | null = null;
    ffmpeg.on("error", (err) => {
      spawnErr = err;
      reject(err);
    });

    ffmpeg.stderr.on("data", () => {
      // Drenar stderr
    });

    ffmpeg.on("close", (code) => {
      if (spawnErr) return;
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg visualizer process exited with code ${code}`));
      }
    });

    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      const buffer = Buffer.alloc(frameSize);

      for (let i = 0; i < numBars; i++) {
        // Multiplicadores enteros de frecuencia para ciclo perfectamente cerrado en durationSeconds
        const k = [8, 6, 5, 4, 7][i % 5];
        const phi = (((i * 7) % numBars) / numBars) * 2 * Math.PI;

        // Onda sinusoidal suave de 0 a 1
        const cycle = 0.5 - 0.5 * Math.cos(2 * Math.PI * k * (t / durationSeconds) + phi);

        let scaleY: number, opacity: number;
        if (cycle <= 0.5) {
          const p = cycle * 2;
          scaleY = 0.2 + (1.0 - 0.2) * p;
          opacity = 0.55 + (1.0 - 0.55) * p;
        } else {
          const p = (cycle - 0.5) * 2;
          scaleY = 1.0 + (0.35 - 1.0) * p;
          opacity = 1.0 + (0.7 - 1.0) * p;
        }

        const baseH = (HEIGHTS[i] * H) / 100;
        const currentH = Math.max(barW, baseH * scaleY);
        const cx = i * (barW + gap) + barW / 2;

        const minX = Math.max(0, Math.floor(cx - barW / 2 - glowRadius));
        const maxX = Math.min(W - 1, Math.ceil(cx + barW / 2 + glowRadius));
        const minY = Math.max(0, Math.floor(cy - currentH / 2 - glowRadius));
        const maxY = Math.min(H - 1, Math.ceil(cy + currentH / 2 + glowRadius));
        const straightH = Math.max(0, currentH - 2 * r);
        const topCapY = cy - straightH / 2;
        const bottomCapY = cy + straightH / 2;

        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            let dist = 0;
            if (y < topCapY) {
              const dy = y - topCapY;
              const dx = x - cx;
              dist = Math.sqrt(dx * dx + dy * dy);
            } else if (y > bottomCapY) {
              const dy = y - bottomCapY;
              const dx = x - cx;
              dist = Math.sqrt(dx * dx + dy * dy);
            } else {
              dist = Math.abs(x - cx);
            }

            const delta = r - dist;
            let barAlpha = 0;
            if (delta >= 0.5) {
              barAlpha = 1;
            } else if (delta > -0.5) {
              barAlpha = delta + 0.5;
            } else if (delta > -glowRadius) {
              // Resplandor difuso equivalente a boxShadow: 0 0 6px ${visColor}33
              barAlpha = (1 - Math.abs(delta) / glowRadius) * 0.22;
            }

            if (barAlpha > 0) {
              const idx = (y * W + x) * 4;
              const finalAlpha = Math.round(barAlpha * opacity * 255);
              buffer[idx] = rCol;
              buffer[idx + 1] = gCol;
              buffer[idx + 2] = bCol;
              buffer[idx + 3] = Math.max(buffer[idx + 3], finalAlpha);
            }
          }
        }
      }

      ffmpeg.stdin.write(buffer);
    }

    ffmpeg.stdin.end();
  });
}
