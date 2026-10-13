const CONVERSATION_ROLES = new Set(["user", "assistant"]);

export interface ConversationLike {
  role: string;
  text?: string | null;
}

export function isConversationMessage(message: ConversationLike): boolean {
  return CONVERSATION_ROLES.has(message.role) && (message.text ?? "").trim() !== "";
}

export function filterConversationMessages<T extends ConversationLike>(messages: T[]): T[] {
  return messages.filter(isConversationMessage);
}
