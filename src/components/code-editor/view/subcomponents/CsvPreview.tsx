import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, Minimize2 } from 'lucide-react';

import PreviewControlButton from '../../../preview/PreviewControlButton';
import { usePreviewFullscreen } from '../../../preview/usePreviewFullscreen';

type CsvPreviewProps = {
  content: string;
  fileName?: string;
};

// Rendering tens of thousands of DOM rows locks the tab up; cap and say so.
const MAX_RENDERED_ROWS = 2000;

/**
 * Minimal RFC-4180 parser: handles quoted fields, escaped quotes ("") and
 * newlines inside quotes — the cases a naive line-split gets wrong.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop a trailing fully-empty row (file ending with a newline).
  if (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) {
    rows.pop();
  }

  return rows;
}

/** Picks the delimiter: extension wins for .tsv, otherwise the most frequent candidate in the first line. */
function sniffDelimiter(content: string, fileName?: string): string {
  if (fileName?.toLowerCase().endsWith('.tsv')) {
    return '\t';
  }
  const firstLine = content.slice(0, content.indexOf('\n') === -1 ? undefined : content.indexOf('\n'));
  let best = ',';
  let bestCount = -1;
  for (const candidate of [',', ';', '\t', '|']) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

const NUMERIC_PATTERN = /^-?\d+(?:[.,]\d+)?%?$/;

export default function CsvPreview({ content, fileName }: CsvPreviewProps) {
  const { t } = useTranslation('codeEditor');
  const [showAll, setShowAll] = useState(false);
  const { isFullscreen, toggleFullscreen } = usePreviewFullscreen();

  const { header, rows, columnCount, totalRows } = useMemo(() => {
    const delimiter = sniffDelimiter(content, fileName);
    const parsed = parseDelimited(content, delimiter);
    const parsedHeader = parsed[0] ?? [];
    const body = parsed.slice(1);
    return {
      header: parsedHeader,
      rows: body,
      columnCount: Math.max(parsedHeader.length, ...body.slice(0, 100).map((r) => r.length), 0),
      totalRows: body.length,
    };
  }, [content, fileName]);

  const visibleRows = showAll ? rows : rows.slice(0, MAX_RENDERED_ROWS);
  const truncated = !showAll && totalRows > MAX_RENDERED_ROWS;

  if (header.length === 0 && rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('csv.empty', 'Empty file')}
      </div>
    );
  }

  return (
    <div
      className={
        // Wide tables are the whole reason to expand: fullscreen buys columns.
        isFullscreen
          ? 'fixed inset-0 z-[10000] flex flex-col bg-background'
          : 'flex h-full flex-col bg-background'
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {t('csv.summary', '{{rows}} rows × {{cols}} columns', { rows: totalRows, cols: columnCount })}
        </span>
        <div className="flex items-center gap-1">
          {truncated && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="rounded px-2 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
            >
              {t('csv.showAll', 'Showing first {{count}} — show all', { count: MAX_RENDERED_ROWS })}
            </button>
          )}
          <PreviewControlButton
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </PreviewControlButton>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/95 backdrop-blur">
              <th className="border-b border-r border-border/60 px-2 py-1.5 text-right font-normal tabular-nums text-muted-foreground/60">
                #
              </th>
              {Array.from({ length: columnCount }, (_, index) => (
                <th
                  key={index}
                  className="max-w-96 truncate border-b border-r border-border/40 px-2.5 py-1.5 text-left font-semibold text-foreground"
                  title={header[index]}
                >
                  {header[index] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-muted/20 hover:bg-accent/40">
                <td className="border-b border-r border-border/40 px-2 py-1 text-right tabular-nums text-muted-foreground/50">
                  {rowIndex + 1}
                </td>
                {Array.from({ length: columnCount }, (_, colIndex) => {
                  const cell = row[colIndex] ?? '';
                  return (
                    <td
                      key={colIndex}
                      title={cell.length > 60 ? cell : undefined}
                      className={`max-w-96 truncate border-b border-r border-border/30 px-2.5 py-1 text-foreground/90 ${
                        NUMERIC_PATTERN.test(cell.trim()) ? 'text-right tabular-nums' : 'text-left'
                      }`}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && (
          <div className="px-3 py-2 text-center text-xs text-muted-foreground">
            {t('csv.truncated', '… {{count}} more rows not shown', { count: totalRows - MAX_RENDERED_ROWS })}
          </div>
        )}
      </div>
    </div>
  );
}
