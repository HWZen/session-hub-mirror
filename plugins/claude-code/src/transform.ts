import { hostname } from "node:os";
import type { SessionUpsertInput } from "../../../packages/shared/src/session.js";
import type { TranscriptSession } from "./transcript.js";
import { MAX_MESSAGES, MAX_TEXT_LENGTH, TRUNCATE_MARK } from "./transcript.js";

export const AGENT = "claude-code";

export function transformSession(transcript: TranscriptSession, machine: string = hostname()): SessionUpsertInput {
  // Filter messages: keep only user (string content) and assistant messages
  const filteredMessages = transcript.messages.filter(msg => {
    // Check if user message has string content (not tool_result)
    if (msg.role === "user") {
      // For user messages, if text is present, it's a string content
      return msg.text !== undefined && msg.text.length > 0;
    }
    // Assistant messages are always kept (already filtered in transcript)
    return msg.role === "assistant";
  });

  // Take last MAX_MESSAGES
  const trimmedMessages = filteredMessages.slice(-MAX_MESSAGES);

  // Process messages to ensure reasoning is normalized to {type:"reasoning", text}
  const processedMessages = trimmedMessages.map(msg => {
    let raw = msg.raw;

    // If raw is an object, normalize thinking to reasoning
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, any>;
      if (obj.type === "thinking" && obj.text) {
        raw = { type: "reasoning", text: obj.text };
      } else if (obj.type === "tool" && obj.state?.output) {
        // Truncate tool output
        const output = obj.state.output as string;
        if (output.length > 100_000) {
          obj.state.output = output.slice(0, 100_000) + TRUNCATE_MARK;
        }
        raw = obj;
      }
    } else if (Array.isArray(raw)) {
      // If raw is an array, iterate through and normalize all thinking parts
      raw = raw.map(part => {
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const p = part as Record<string, any>;
          if (p.type === "thinking" && p.text) {
            return { type: "reasoning", text: p.text };
          }
          if (p.type === "tool" && p.state?.output) {
            const output = p.state.output as string;
            if (output.length > 100_000) {
              p.state.output = output.slice(0, 100_000) + TRUNCATE_MARK;
            }
          }
        }
        return part;
      });
    }

    return {
      role: msg.role,
      text: msg.text ? truncateText(msg.text, MAX_TEXT_LENGTH) : undefined,
      ts: msg.ts,
      raw
    };
  });

  // Construct the session
  const session: SessionUpsertInput = {
    agent: AGENT,
    machine,
    source_id: transcript.sessionId,
    title: transcript.title || "Untitled Claude Code session",
    cwd: transcript.cwd,
    created_at: transcript.createdAt,
    updated_at: transcript.updatedAt,
    messages: processedMessages
  };

  return session;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATE_MARK;
}
