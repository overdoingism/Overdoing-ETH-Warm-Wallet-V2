import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';
import { QRCanvas, frameLoop, rearCamera } from 'qr/dom.js';

/** QR code as an SVG data URL: crisp at any size, and an <img> can be long-pressed to save. */
export function qrDataUrl(text) {
  const svg = encodeQR(text, 'svg', { ecc: 'medium', border: 3 });
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/**
 * Starts the camera and calls onResult(text) once a QR code is read.
 * Returns { stop, next } — next() switches to another camera when there are several.
 */
export async function startScanner(video, overlay, onResult) {
  const camera = await rearCamera(video);
  const canvas = new QRCanvas({ overlay });
  let stopped = false;
  let busy = false;
  const cancel = frameLoop(async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const text = await camera.readFrame(canvas);
      if (typeof text === 'string' && text && !stopped) {
        stop();
        onResult(text);
      }
    } catch {
      // a frame without a readable code
    } finally {
      busy = false;
    }
  }, video);
  function stop() {
    if (stopped) return;
    stopped = true;
    cancel();
    camera.stop();
  }
  async function next() {
    const devices = await camera.listDevices();
    if (devices.length < 2) return false;
    const current = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
    const i = devices.findIndex((d) => d.deviceId === current);
    await camera.setDevice(devices[(i + 1) % devices.length].deviceId);
    return true;
  }
  return { stop, next };
}

/** Reads a QR code from a photo or screenshot (also the camera-less fallback on phones). */
export async function decodeImageFile(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return decodeQR(ctx.getImageData(0, 0, w, h), { effort: Infinity, timeLimit: 3000 });
}
