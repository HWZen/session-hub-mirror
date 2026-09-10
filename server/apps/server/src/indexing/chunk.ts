export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

export interface TextChunk {
  text: string;
  char_start: number;
}

export const DEFAULT_CHUNK_MAX_CHARS = 1200;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 180;

const DEFAULT_OPTIONS: ChunkOptions = {
  maxChars: DEFAULT_CHUNK_MAX_CHARS,
  overlapChars: DEFAULT_CHUNK_OVERLAP_CHARS,
};

const BREAK_SEPARATORS = ["\n\n", "\n", " ", "\t"] as const;

function findBreak(text: string, start: number, end: number): number {
  const window = text.slice(start, end);
  for (const separator of BREAK_SEPARATORS) {
    const at = window.lastIndexOf(separator);
    if (at > 0) return start + at + separator.length;
  }
  return end;
}

export function chunkText(text: string, options: ChunkOptions = DEFAULT_OPTIONS): TextChunk[] {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const overlapChars = Math.max(0, Math.min(Math.floor(options.overlapChars), maxChars - 1));
  if (text.trim() === "") return [];

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) end = findBreak(text, start, end);
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body !== "") chunks.push({ text: body, char_start: start + lead });
    if (end >= text.length) break;
    const next = end - overlapChars;
    start = next > start ? next : end;
  }
  return chunks;
}
