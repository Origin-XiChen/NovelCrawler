import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { ScanLine, X } from 'lucide-react';

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

interface Props {
  onClose: () => void;
  onResult: (raw: string) => void;
}

const CAMERA_HINT = '无法打开摄像头，请检查系统相机权限，或手动输入地址和配对码。';

export default function ScannerModal({ onClose, onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const resultRef = useRef(onResult);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  resultRef.current = onResult;

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer = 0;

    const stop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    const run = async () => {
      if (!window.isSecureContext) {
        setError('当前页面不是安全上下文，无法调用摄像头。请手动输入地址和配对码。');
        setStarting(false);
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(CAMERA_HINT);
        setStarting(false);
        return;
      }

      const BarcodeDetector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
        .BarcodeDetector;
      let detector: BarcodeDetectorLike | null = null;
      if (BarcodeDetector) {
        try {
          detector = new BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // 不指定分辨率时安卓 WebView 默认给 480p 甚至 320×240,预览糊成一片、
          // 高密度配对码根本扫不动。这里要 1080p,拿不到时再逐级降级。
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        }).catch(() => navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        })).catch(() => navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        }));
        if (cancelled) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await new Promise<void>((resolve) => {
          if (video.readyState >= 2) resolve();
          else video.onloadedmetadata = () => resolve();
        });
        await video.play();
        // 连续对焦:不少安卓机默认是固定焦距,离二维码二十厘米就糊
        try {
          const track = stream.getVideoTracks()[0];
          const caps = (track.getCapabilities?.() || {}) as { focusMode?: string[] };
          if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
            await track.applyConstraints({
              advanced: [{ focusMode: 'continuous' }],
            } as unknown as MediaTrackConstraints);
          }
        } catch {
          // 设备不支持就算了,不影响扫码
        }
        if (cancelled) return;
        setStarting(false);

        const tick = async () => {
          if (cancelled) return;
          let raw = '';
          try {
            if (detector) {
              const codes = await detector.detect(video);
              raw = codes[0]?.rawValue || '';
            } else if (context) {
              const width = video.videoWidth;
              const height = video.videoHeight;
              if (width && height) {
                const scale = Math.min(1, 720 / Math.max(width, height));
                canvas.width = Math.round(width * scale);
                canvas.height = Math.round(height * scale);
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                const frame = context.getImageData(0, 0, canvas.width, canvas.height);
                raw =
                  jsQR(frame.data, frame.width, frame.height, {
                    inversionAttempts: 'dontInvert',
                  })?.data || '';
              }
            }
          } catch {
            // 单帧识别失败继续下一帧
          }
          if (raw) {
            cancelled = true;
            stop();
            resultRef.current(raw);
            return;
          }
          if (!cancelled) timer = window.setTimeout(tick, 280);
        };
        void tick();
      } catch {
        setError(CAMERA_HINT);
        setStarting(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stop();
    };
  }, []);

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label="扫描二维码">
      <video ref={videoRef} className="scanner__video" muted playsInline />
      <div className="scanner__mask">
        <div className="scanner__frame">
          <span className="scanner__corner scanner__corner--tl" />
          <span className="scanner__corner scanner__corner--tr" />
          <span className="scanner__corner scanner__corner--bl" />
          <span className="scanner__corner scanner__corner--br" />
          {starting && !error && <div className="scanner__loading">正在打开摄像头…</div>}
        </div>
      </div>
      <div className="scanner__top">
        <div className="scanner__title">
          <ScanLine size={18} />
          扫描电脑上的配对二维码
        </div>
        <button type="button" className="scanner__close" onClick={onClose} aria-label="关闭扫码">
          <X size={22} />
        </button>
      </div>
      {error ? (
        <div className="scanner__error">{error}</div>
      ) : (
        <div className="scanner__hint">将电脑「手机连接」页的二维码放入框内</div>
      )}
    </div>
  );
}
