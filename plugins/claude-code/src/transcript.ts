import { readFileSync } from "node:fs";

export const MAX_TEXT_LENGTH = 1_000_000;
export const MAX_MESSAGES = 5000;
export const MAX_TOOL_OUTPUT_LENGTH = 100_000;
export const TRUNCATE_MARK = "\n\n[session-hub: truncated]";

export interface ClaudeEntry {
  type: string;
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  cwd: string;
  timestamp: string;
  version: string;
  message?: {
    id: string;
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }> | string;
  };
  aiTitle?: {
    aiTitle: string;
    sessionId: string;
  };
}

export interface TranscriptSession {
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  messages: Array<{
    role: string;
    text?: string;
    ts: number;
    raw: unknown;
  }>;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATE_MARK;
}

export function readTranscript(path: string): ClaudeEntry[] {
  const content = readFileSync(path, "utf8");
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as ClaudeEntry);
}

export function groupTranscript(entries: ClaudeEntry[]): TranscriptSession {
  const sessionId = entries[0]?.sessionId || "";
  const cwd = entries[0]?.cwd || "";

  // Filter out unwanted entry types
  const filtered = entries.filter(entry => {
    const skipTypes = new Set([
      "attachment", "ai-title", "last-prompt", "system",
      "queue-operation", "mode", "permission-mode", "atis-latch",
      "file-history-snapshot", "cost-state"
    ]);
    return !skipTypes.has(entry.type);
  });

  // Get title from ai-title entries
  const aiTitle = entries
    .filter(e => e.type === "ai-title" && e.aiTitle)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .map(e => e.aiTitle?.aiTitle)[0];

  // Extract all messages
  const messagesByMessageId = new Map<string, ClaudeEntry[]>();
  const toolResults = new Map<string, ClaudeEntry>();

  for (const entry of filtered) {
    if (entry.type === "user" || entry.type === "assistant") {
      if (entry.message?.id) {
        const arr = messagesByMessageId.get(entry.message.id) || [];
        arr.push(entry);
        messagesByMessageId.set(entry.message.id, arr);
      }
    } else if (entry.type === "tool_result" && entry.message?.id) {
      toolResults.set(entry.message.id, entry);
    }
  }

  // Process messages
  const messages: TranscriptSession["messages"] = [];

  for (const [messageId, entries] of messagesByMessageId) {
    // Sort by apiBlockIndex if available
    const sorted = entries.sort((a, b) => {
      const idxA = (a.message as any)?.apiBlockIndex ?? 0;
      const idxB = (b.message as any)?.apiBlockIndex ?? 0;
      return idxA - idxB;
    });

    // Combine all parts
    const role = sorted[0].type === "user" ? "user" : "assistant";
    const rawParts: any[] = [];
    const textPieces: string[] = [];

    for (const entry of sorted) {
      if (!entry.message?.content) continue;

      const content = entry.message.content;
      const parts = Array.isArray(content) ? content : [{ type: "text", text: content }];

      for (const part of parts) {
        if (part.type === "thinking" && part.thinking !== undefined) {
          rawParts.push({ type: "reasoning", text: part.thinking });
          textPieces.push(`[Thinking] ${part.thinking}`);
        } else if (part.type === "text" && part.text !== undefined) {
          rawParts.push({ type: "text", text: part.text });
          textPieces.push(part.text);
        } else if (part.type === "tool_use" && part.id !== undefined && part.name !== undefined && part.input !== undefined) {
          const toolPart = {
            type: "tool",
            callID: part.id,
            tool: part.name,
            state: { status: "completed", input: part.input }
          };

          // Check if there's a tool_result for this tool_use
          const toolResult = toolResults.get(messageId);
          if (toolResult?.message?.content && Array.isArray(toolResult.message.content)) {
            for (const trPart of toolResult.message.content) {
              if (trPart.type === "tool_result" && (trPart as any).tool_use_id === part.id && trPart.text !== undefined) {
                toolPart.state.output = truncateText(trPart.text, MAX_TOOL_OUTPUT_LENGTH);
              }
            }
          }

          rawParts.push(toolPart);
        }
      }
    }

    const text = truncateText(textPieces.join("\n\n"), MAX_TEXT_LENGTH);
    const ts = new Date(sorted[0].timestamp).getTime();

    messages.push({
      role,
      text,
      ts,
      raw: rawParts.length === 1 ? rawParts[0] : rawParts
    });
  }

  // Sort messages by timestamp
  messages.sort((a, b) => a.ts - b.ts);

  // Take last MAX_MESSAGES
  const trimmedMessages = messages.slice(-MAX_MESSAGES);

  // Get created/updated times
  const timestamps = filtered.map(e => new Date(e.timestamp).getTime());
  const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();

  // If no title from ai-title, use first user message
  const firstUserMessage = trimmedMessages.find(m => m.role === "user");
  const title = (aiTitle ?? firstUserMessage?.text?.slice(0, 200) ?? "Untitled session");

  return {
    sessionId,
    cwd,
    createdAt,
    updatedAt,
    title: truncateText(title, 2000),
    messages: trimmedMessages
  };
}
