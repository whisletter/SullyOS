/**
 * PDF → 牌面图片：一页画成一张 JPEG。
 *
 * PDF.js 和 worker 的引入方式与 utils/pdfText.ts 完全一致（随项目打包，不走 CDN），
 * 所以不需要新装依赖。
 */

import * as bundledPdfJs from 'pdfjs-dist';
import bundledPdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url';

interface PdfViewport { width: number; height: number }
interface PdfRenderPage {
  getViewport: (opts: { scale: number }) => PdfViewport;
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => { promise: Promise<void> };
  cleanup?: () => void;
}
interface PdfRenderDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfRenderPage>;
  destroy?: () => Promise<void> | void;
}
interface PdfJsRender {
  getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<PdfRenderDoc> };
  GlobalWorkerOptions?: { workerSrc?: string };
}

/** 每页画出来的高度（px），牌面在屏幕上最大一百多 px 宽，这个清晰度足够 */
const TARGET_HEIGHT = 1000;

export function isPdf(file: File): boolean {
  return file.type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export async function renderPdfPages(
  file: File,
  maxPages: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob[]> {
  const pdfjs = bundledPdfJs as unknown as PdfJsRender;
  if (!pdfjs?.getDocument) throw new Error('PDF 功能加载失败');
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = bundledPdfWorkerSrc;
  }

  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const total = Math.min(doc.numPages, maxPages);
  const blobs: Blob[] = [];

  try {
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(4, TARGET_HEIGHT / Math.max(1, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 不可用');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
        // 释放画布内存，手机上连着画几十页很吃内存
        canvas.width = 0;
        canvas.height = 0;
        if (!blob) throw new Error(`第 ${n} 页转换失败`);
        blobs.push(blob);
      } finally {
        page.cleanup?.();
      }
      onProgress?.(n, total);
    }
  } finally {
    await doc.destroy?.();
  }
  return blobs;
}
