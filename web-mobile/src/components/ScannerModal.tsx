import { useEffect, useRef, useState } from 'react';
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
        setError('局域网 HTTP 下浏览器不允许调用摄像头。请用手机系统相机扫描电脑二维码，或手动输入地址和配对码。');
        setStarting(false);
        return;
      }
      const BarcodeDetector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (!BarcodeDetector) {
        setError('当前浏览器不支持网页扫码。请用手机系统相机扫描，或手动输入。');
        setStarting(false);
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前环境无法调用摄像头，请手动输入。');
        setStarting(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
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
        if (cancelled) return;
        setStarting(false);
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (cancelled) return;
          try {
            const codes = await detector.detect(video);
            const raw = codes[0]?.rawValue || '';
            if (raw) {
              cancelled = true;
              stop();
              resultRef.current(raw);
              return;
            }
          } catch {
            // 单帧识别失败继续下一帧
          }
          if (!cancelled) timer = window.setTimeout(tick, 280);
        };
        void tick();
      } catch {
        setError('无法打开摄像头，请检查权限，或改用手动输入。');
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
