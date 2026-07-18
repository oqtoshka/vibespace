import { useEffect, useState } from 'react';
import { FileIcon } from 'lucide-react';

interface ImageAttachmentProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

const ImageAttachment = ({ file, onRemove, uploadProgress, error }: ImageAttachmentProps) => {
  const isImage = file.type.startsWith('image/');
  const [preview, setPreview] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="group relative">
      {isImage ? (
        <div className="overflow-hidden rounded-xl border border-border/50 shadow-sm">
          <img src={preview} alt={file.name} className="h-20 w-20 object-cover" />
        </div>
      ) : (
        <div
          className="flex h-20 w-32 flex-col items-center justify-center gap-1 rounded-xl border border-border/60 bg-muted/40 px-2"
          title={file.name}
        >
          <FileIcon className="h-6 w-6 flex-shrink-0 text-muted-foreground" />
          <span className="w-full truncate text-center text-[11px] text-foreground">{file.name}</span>
          <span className="text-[10px] text-muted-foreground">{formatSize(file.size)}</span>
        </div>
      )}
      {uploadProgress !== undefined && uploadProgress < 100 && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50">
          <div className="text-xs text-white">{uploadProgress}%</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-red-500/50">
          <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label="Remove attachment"
      >
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

export default ImageAttachment;
