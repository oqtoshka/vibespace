import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfPagesProps = {
  data: ArrayBuffer;
  title: string;
  onError: (message: string) => void;
};

type PageSize = { width: number; height: number };

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

// pdf.js is only needed once a PDF is opened, so it and its worker load lazily.
function loadPdfjs() {
  pdfjsPromise ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsPromise;
}

/**
 * Renders every page of a PDF as a vertical stack of canvases, fitted to the
 * container width. Replaces the browser's native viewer, which Safari shows
 * as a single page when the PDF sits in an iframe. Pages are drawn when they
 * scroll near the viewport, so a long deck does not rasterise all at once.
 */
export default function PdfPages({ data, title, onError }: PdfPagesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [width, setWidth] = useState(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof import('pdfjs-dist').getDocument> | null = null;
    setDoc(null);
    setSizes([]);
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // pdf.js transfers the buffer to its worker; keep the caller's copy intact.
        if (cancelled) return;
        task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
        const loaded = await task.promise;
        const pageSizes: PageSize[] = [];
        for (let index = 1; index <= loaded.numPages; index += 1) {
          const viewport = (await loaded.getPage(index)).getViewport({ scale: 1 });
          pageSizes.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled) return;
        setSizes(pageSizes);
        setDoc(loaded);
      } catch (error) {
        if (!cancelled) onErrorRef.current((error as Error)?.message || 'Could not render this PDF.');
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 120);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  // 16px padding on each side of the page column.
  const pageWidth = Math.max(0, width - 32);

  return (
    <div ref={scrollRef} className="h-full w-full overflow-auto" aria-label={title} data-testid="pdf-pages">
      {doc && pageWidth > 0 ? (
        <div className="flex flex-col items-center gap-4 p-4">
          {sizes.map((size, index) => (
            <PdfPage key={index} doc={doc} pageNumber={index + 1} size={size} width={pageWidth} root={scrollRef} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type PdfPageProps = {
  doc: PDFDocumentProxy;
  pageNumber: number;
  size: PageSize;
  width: number;
  root: React.RefObject<HTMLDivElement | null>;
};

function PdfPage({ doc, pageNumber, size, width, root }: PdfPageProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const height = Math.round((width * size.height) / size.width);

  useEffect(() => {
    const element = holderRef.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setVisible(true);
      },
      { root: root.current, rootMargin: '100% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, visible]);

  useEffect(() => {
    if (!visible || !canvasRef.current || width <= 0) return;
    const canvas = canvasRef.current;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: (width / size.width) * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      await task.promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, size.width, visible, width]);

  return (
    <div
      ref={holderRef}
      className="shrink-0 bg-white shadow-md"
      style={{ width, height }}
      data-page={pageNumber}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
