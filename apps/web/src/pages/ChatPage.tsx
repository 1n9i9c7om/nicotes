import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  Check,
  FilePen,
  FileText,
  ListChecks,
  Loader2,
  MessagesSquare,
  NotebookPen,
  RotateCcw,
  Search,
  Send,
  Square,
  Telescope,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ChatAction, ChatEntry, ChatEvent } from '@nicotes/shared';
import { Markdown } from '../components/Markdown';
import { ConfirmDialog } from '../components/Modal';
import { aiKeyFor } from '../lib/ai';
import { api, postStream } from '../lib/api';
import { useSettings } from '../lib/queries';

const chatKey = ['chat'] as const;

const ICONS: Record<string, LucideIcon> = {
  search_notes: Search,
  search_by_meaning: Search,
  read_page: FileText,
  list_notebooks: FileText,
  list_pages: FileText,
  create_page: FilePen,
  append_to_page: FilePen,
  read_journal: NotebookPen,
  write_journal: NotebookPen,
  list_tasks: ListChecks,
  add_task: ListChecks,
  update_task: Check,
  calendar: CalendarDays,
  start_research: Telescope,
  research_status: Telescope,
};

const SUGGESTIONS = [
  'What is due this week?',
  'Remind me to call the dentist tomorrow at 9:00',
  'Write in my journal that the garden needs water',
  'What did I note about the car?',
];

function Actions({ actions }: { actions: ChatAction[] }) {
  if (!actions.length) return null;
  return (
    <ul className="chat-actions">
      {actions.map((a, i) => {
        const Icon = a.ok ? (ICONS[a.tool] ?? Check) : AlertTriangle;
        return (
          <li key={i} className={a.ok ? undefined : 'failed'}>
            <Icon size={13} />
            {a.pageId ? <Link to={`/p/${a.pageId}`}>{a.summary}</Link> : <span>{a.summary}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The chat: an assistant that uses Nicotes for you. It searches and reads notes, writes
 * pages and the journal, manages tasks, shows the calendar and starts research; each step
 * shows up as it happens. "New chat" forgets the conversation.
 */
export function ChatPage() {
  const qc = useQueryClient();
  const settings = useSettings();
  const history = useQuery({ queryKey: chatKey, queryFn: () => api.get<ChatEntry[]>('/chat') });
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ text: string; actions: ChatAction[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const keyCheck = aiKeyFor(settings.data, 'ask', 'The chat');
  const messages = history.data ?? [];

  // Braces: newer browsers return a promise from scrollIntoView, which React would take
  // for a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, pending]);

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message || pending) return;
    setText('');
    setError(null);
    setPending({ text: message, actions: [] });
    controller.current = new AbortController();
    let changed = false;
    try {
      await postStream<ChatEvent>(
        '/chat',
        { text: message },
        (event) => {
          if (event.type === 'user') {
            qc.setQueryData<ChatEntry[]>(chatKey, (list = []) => [...list, event.entry]);
            setPending((p) => p && { ...p, text: '' });
          } else if (event.type === 'action') {
            changed ||= event.action.ok && !/^(search|read|list|calendar|research_status)/.test(event.action.tool);
            setPending((p) => p && { ...p, actions: [...p.actions, event.action] });
          } else if (event.type === 'answer') {
            qc.setQueryData<ChatEntry[]>(chatKey, (list = []) => [...list, event.entry]);
          } else {
            setError(event.error);
          }
        },
        controller.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setPending(null);
      controller.current = null;
      // Pages, tasks or the journal may have changed.
      if (changed) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== chatKey[0] });
      input.current?.focus();
    }
  };

  // From the search box ("Chat: …"): sent once, then the address is cleaned up.
  const asked = useRef(false);
  useEffect(() => {
    const q = params.get('q');
    if (!q || asked.current || !history.isSuccess) return;
    asked.current = true;
    setParams({}, { replace: true });
    void send(q);
  }, [params, history.isSuccess]);

  const reset = async () => {
    await api.delete('/chat');
    qc.setQueryData<ChatEntry[]>(chatKey, []);
    setError(null);
    setResetting(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  return (
    <div className="content chat-page">
      <header className="content-header chat-header">
        <div>
          <h1>
            <MessagesSquare size={26} /> Chat
          </h1>
          <p className="muted">
            Ask about your notes, or let the assistant do things for you: add tasks, write in the journal, plan your week,
            start research.
          </p>
        </div>
        {messages.length > 0 && (
          <button className="btn btn-sm" disabled={!!pending} onClick={() => setResetting(true)}>
            <RotateCcw size={14} /> New chat
          </button>
        )}
      </header>

      {keyCheck.message && (
        <div className="banner banner-warning" role="alert">
          <AlertTriangle size={18} />
          <span>
            {keyCheck.message} <Link to="/settings#models">Settings</Link>
          </span>
        </div>
      )}

      <div className="chat-log" role="log" aria-live="polite">
        {messages.length === 0 && !pending && history.isSuccess && (
          <div className="chat-empty">
            <p className="muted">Try:</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => void send(s)} disabled={!keyCheck.ready}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="chat-msg from-user">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="chat-msg from-assistant">
              <Actions actions={m.actions} />
              <Markdown text={m.content} />
            </div>
          ),
        )}
        {pending && (
          <>
            {pending.text && <div className="chat-msg from-user">{pending.text}</div>}
            <div className="chat-msg from-assistant">
              <Actions actions={pending.actions} />
              <span className="chat-working muted">
                <Loader2 size={15} className="spin" /> Working…
              </span>
            </div>
          </>
        )}
        {error && (
          <p className="error chat-error">
            <X size={14} /> {error}
          </p>
        )}
        <div ref={end} />
      </div>

      <form className="chat-input" onSubmit={submit}>
        <textarea
          ref={input}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder="Message the assistant…"
          aria-label="Message"
          value={text}
          maxLength={8000}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        {pending ? (
          <button type="button" className="btn" aria-label="Stop" onClick={() => controller.current?.abort()}>
            <Square size={15} />
          </button>
        ) : (
          <button className="btn btn-primary" aria-label="Send" disabled={!text.trim() || !keyCheck.ready}>
            <Send size={15} />
          </button>
        )}
      </form>

      {resetting && (
        <ConfirmDialog
          title="Start a new chat?"
          message="The assistant forgets this conversation. Pages, tasks and journal entries it wrote stay as they are."
          confirmLabel="New chat"
          onConfirm={() => void reset()}
          onClose={() => setResetting(false)}
        />
      )}
    </div>
  );
}
