import { z } from 'zod';

/**
 * The chat: an AI assistant that uses Nicotes for you (searches and reads notes, writes
 * pages and the journal, manages tasks, shows the calendar, starts research). The web app
 * and Telegram each have a conversation of their own.
 */
export const CHAT_CHANNELS = ['web', 'telegram'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

/** Something the assistant did while answering, e.g. "Created the task …". */
export interface ChatAction {
  /** The tool's name, e.g. "add_task". */
  tool: string;
  summary: string;
  /** The page it read, wrote or found, to link to. */
  pageId?: string;
  ok: boolean;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions: ChatAction[];
  createdAt: number;
}

export const chatSendSchema = z.object({ text: z.string().trim().min(1).max(8000) });

/** POST /api/chat streams these (server-sent events), the last being the answer or an error. */
export type ChatEvent =
  | { type: 'user'; entry: ChatEntry }
  | { type: 'action'; action: ChatAction }
  | { type: 'answer'; entry: ChatEntry }
  | { type: 'error'; error: string };
