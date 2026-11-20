import React from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { TemplateConfig } from '../pages/Dashboard';

export const isVideoUrl = (url?: string): boolean => {
  if (!url) return false;
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  return (
    clean.endsWith('.mp4') ||
    clean.endsWith('.webm') ||
    clean.endsWith('.mov') ||
    clean.endsWith('.m4v') ||
    url.startsWith('data:video/')
  );
};

export interface VideoEditorPreviewProps {
  config: TemplateConfig;
  onUpdateConfig?: (newConfig: any) => void;
  backgroundUrl: string;
  customBackground?: string;
  userPhotoUrl: string;
  titulo: string;
  artista: string; // Utilizado para la Firma
  dedicatoria: string;
  
  // Explicit coordinate overrides
  photoX?: number;
  photoY?: number;
  photoWidth?: number;
  photoHeight?: number;
  tituloX?: number | string;
  tituloY?: number;
  tituloSize?: number;
  artistaX?: number | string;
  artistaY?: number;
  artistaSize?: number;
  dedicatoriaX?: number | string;
  dedicatoriaY?: number;
  dedicatoriaSize?: number;

  visualizer?: {
    enabled?: boolean;
    x?: number | string;
    y?: number;
    w?: number;
    h?: number;
    color?: string;
  };

  scale: number;
}

export const VideoEditorPreview: React.FC<VideoEditorPreviewProps> = ({
  config,
  backgroundUrl,
  customBackground,
  userPhotoUrl,
  titulo,
  artista,
  dedicatoria,
  
  photoX,
  photoY,
  photoWidth,
  photoHeight,
  tituloX,
  tituloY,
  tituloSize,
  artistaX,
  artistaY,
  artistaSize,
  dedicatoriaX,
  dedicatoriaY,
  dedicatoriaSize,
  visualizer,
  
  scale
}) => {

  const renderTextNode = (key: 'titulo' | 'artista' | 'dedicatoria', text: string, placeholder: string) => {
    const t = config?.[key] || { x: 130, y: 1040, fontSize: 36, color: 'white', align: 'left', visible: true };
    
    // Si la visibilidad está desactivada, no se renderiza
    if (t.visible === false) return null;

    // Resolve dynamic positions/sizes
    let activeX: number | string = t.x;
    let activeY: number = t.y;
    let activeSize: number = t.fontSize;

    if (key === 'titulo') {
      if (tituloX !== undefined) activeX = tituloX;
      if (tituloY !== undefined) activeY = tituloY;
      if (tituloSize !== undefined) activeSize = tituloSize;
    } else if (key === 'artista') {
      if (artistaX !== undefined) activeX = artistaX;
      if (artistaY !== undefined) activeY = artistaY;
      if (artistaSize !== undefined) activeSize = artistaSize;
    } else if (key === 'dedicatoria') {
      if (dedicatoriaX !== undefined) activeX = dedicatoriaX;
      if (dedicatoriaY !== undefined) activeY = dedicatoriaY;
      if (dedicatoriaSize !== undefined) activeSize = dedicatoriaSize;
    }

    const align = t.align || (key === 'dedicatoria' ? 'center' : 'left');

    const styleObj: React.CSSProperties = {
      top: `${(activeY / 1920) * 100}%`,
      fontSize: `${activeSize * scale}px`,
      color: t.color,
      textAlign: align,
      lineHeight: '1.25',
    };

    if (align === 'center') {
      styleObj.left = '50%';
      styleObj.transform = 'translateX(-50%)';
      styleObj.width = '84%';
      styleObj.maxWidth = '84%';
    } else if (align === 'right') {
      styleObj.right = '8%';
      styleObj.width = '84%';
      styleObj.maxWidth = '84%';
    } else {
      // left
      const leftPercent = activeX === 'center' ? '8%' : `${(Number(activeX) / 1080) * 100}%`;
      styleObj.left = leftPercent;
      styleObj.width = `calc(92% - ${leftPercent})`;
      styleObj.maxWidth = '84%';
    }

    return (
      <div
        className="absolute whitespace-pre-wrap break-words drop-shadow-md font-cursive tracking-wide select-none"
        style={styleObj}
      >
        {text || placeholder}
      </div>
    );
  };

  const finalPhotoX = photoX !== undefined ? photoX : (config?.photo?.x ?? 130);
  const finalPhotoY = photoY !== undefined ? photoY : (config?.photo?.y ?? 180);
  const finalPhotoW = photoWidth !== undefined ? photoWidth : (config?.photo?.w ?? 820);
  const finalPhotoH = photoHeight !== undefined ? photoHeight : (config?.photo?.h ?? 820);
  const hasPolaroidFrame = config?.photo?.frame !== false;

  // Background resolution
  const resolvedBg = (() => {
    const raw = backgroundUrl === 'custom' && customBackground ? customBackground : backgroundUrl;
    if (!raw) return '';
    const trimmed = raw.trim();
    if (trimmed.startsWith('http') || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
      return trimmed;
    }
    return trimmed.startsWith('/media/') ? trimmed : `/media/${trimmed}`;
  })();

  const isVideo = isVideoUrl(resolvedBg);

  // Visualizer configuration
  const visConfig = visualizer || config?.visualizer || {
    enabled: true,
    x: 130,
    y: 1180,
    w: 820,
    h: 70,
    color: '#FFFFFF'
  };

  const isVisEnabled = visConfig.enabled !== false;
  const visX = visConfig.x ?? 130;
  const visY = visConfig.y ?? 1180;
  const visW = visConfig.w ?? 820;
  const visH = visConfig.h ?? 70;
  const visColor = visConfig.color || '#FFFFFF';

  const renderVisualizer = () => {
    if (!isVisEnabled) return null;

    // 38 bars with varying heights modeling a musical waveform / frequency spectrum
    const heights = [
      25, 45, 65, 35, 75, 90, 50, 75, 100, 85, 45, 65, 80, 95, 70, 50,
      85, 100, 65, 45, 70, 95, 80, 55, 85, 90, 60, 40, 75, 85, 50, 65,
      40, 60, 35, 50, 30, 20
    ];

    return (
      <div
        className="absolute pointer-events-none flex items-center justify-between"
        style={{
          left: visX === 'center' ? '50%' : `${(Number(visX) / 1080) * 100}%`,
          top: `${(Number(visY) / 1920) * 100}%`,
          width: `${(Number(visW) / 1080) * 100}%`,
          height: `${(Number(visH) / 1920) * 100}%`,
          transform: visX === 'center' ? 'translateX(-50%)' : 'none',
        }}
      >
        <div className="w-full h-full flex items-center justify-between gap-[1.5px] px-0.5">
          {heights.map((h, i) => {
            const duration = 0.5 + ((i % 5) * 0.14);
            const delay = ((i * 0.05) % 0.6);
            return (
              <span
                key={i}
                className="rounded-full transition-all"
                style={{
                  width: `${100 / (heights.length * 1.6)}%`,
                  minWidth: '2px',
                  height: `${h}%`,
                  backgroundColor: visColor,
                  transformOrigin: 'center',
                  animation: `soundWave ${duration}s ease-in-out ${delay}s infinite alternate`,
                  boxShadow: `0 0 6px ${visColor}33`,
                }}
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="relative w-full h-full bg-black rounded-xl overflow-hidden border border-gray-800 shadow-2xl shrink-0 aspect-[9/16]">
      {/* Background (Video Live Wallpaper or Image) */}
      {resolvedBg ? (
        isVideo ? (
          <video
            key={resolvedBg}
            src={resolvedBg}
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover object-center"
          />
        ) : (
          <img
            src={resolvedBg}
            alt="Fondo"
            className="absolute inset-0 w-full h-full object-cover object-center"
          />
        )
      ) : (
        <div className="absolute inset-0 w-full h-full bg-gray-900" />
      )}

      {/* Cover Photo: Polaroid Frame or Standard */}
      <div
        className="absolute"
        style={{
          left: `${(finalPhotoX / 1080) * 100}%`,
          top: `${(finalPhotoY / 1920) * 100}%`,
          width: `${(finalPhotoW / 1080) * 100}%`,
          height: `${(finalPhotoH / 1920) * 100}%`,
        }}
      >
        {hasPolaroidFrame ? (
          /* Marco de fotografía blanco estilo Polaroid con espacio extendido inferior */
          <div className="w-full h-full bg-white rounded-[2px] shadow-[0_12px_28px_rgba(0,0,0,0.45)] border border-neutral-100 p-[4%] pb-[17%] flex flex-col justify-start">
            <div className="w-full flex-1 aspect-square overflow-hidden bg-neutral-900 rounded-[1px] relative shadow-inner">
              {userPhotoUrl ? (
                <img src={userPhotoUrl.trim()} alt="Cover" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-neutral-800/90 flex flex-col items-center justify-center text-neutral-400">
                  <ImageIcon className="w-8 h-8 md:w-12 md:h-12 mb-2 opacity-60" />
                  <span className="text-[10px] md:text-xs font-medium text-center">Foto</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Sin marco */
          <div className="w-full h-full overflow-hidden rounded-md shadow-2xl">
            {userPhotoUrl ? (
              <img src={userPhotoUrl.trim()} alt="Cover" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-gray-800/80 backdrop-blur flex flex-col items-center justify-center text-gray-400 rounded-md border-2 border-dashed border-gray-600">
                <ImageIcon className="w-8 h-8 md:w-12 md:h-12 mb-2" />
                <span className="text-[10px] md:text-xs font-medium text-center">Cover Photo</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Texts in Cursive */}
      {renderTextNode('titulo', titulo, 'Título de Canción')}
      {renderTextNode('artista', artista, 'Firma')}
      {renderTextNode('dedicatoria', dedicatoria, 'Mensaje de dedicatoria...')}

      {/* Visualización Musical */}
      {renderVisualizer()}
    </div>
  );
};
