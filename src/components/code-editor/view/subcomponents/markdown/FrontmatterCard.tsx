import { stringify as stringifyYaml } from 'yaml';

type FrontmatterCardProps = {
  frontmatter: Record<string, unknown>;
};

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

function formatScalar(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

function FrontmatterValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="italic text-muted-foreground">—</span>;
  }

  if (value instanceof Date) {
    return <span>{value.toISOString().replace(/T00:00:00\.000Z$/, '')}</span>;
  }

  if (isScalar(value)) {
    if (typeof value === 'boolean') {
      return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{String(value)}</code>;
    }
    return <span className="whitespace-pre-wrap break-words">{formatScalar(value)}</span>;
  }

  if (Array.isArray(value) && value.every((item) => isScalar(item))) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item, index) => (
          <span
            key={index}
            className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
          >
            {formatScalar(item as string | number | boolean)}
          </span>
        ))}
      </span>
    );
  }

  // Nested mappings and mixed lists: show compact YAML rather than flattening
  // structure the author cared enough to nest.
  let yamlText: string;
  try {
    yamlText = stringifyYaml(value).trimEnd();
  } catch {
    yamlText = String(value);
  }
  return (
    <pre className="overflow-x-auto whitespace-pre rounded bg-muted p-2 font-mono text-xs">
      {yamlText}
    </pre>
  );
}

/** GitHub-style metadata table for a document's YAML frontmatter. */
export default function FrontmatterCard({ frontmatter }: FrontmatterCardProps) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="border-b border-border last:border-b-0">
              <th
                scope="row"
                className="w-0 whitespace-nowrap bg-muted px-3 py-2 text-left align-top font-mono text-xs font-semibold text-muted-foreground"
              >
                {key}
              </th>
              <td className="px-3 py-2 align-top">
                <FrontmatterValue value={value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
