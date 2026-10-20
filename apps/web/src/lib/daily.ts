import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { applyTemplate, TEMPLATE_TAG, type Page, type TemplateVars } from '@nicotes/shared';
import { api } from './api';
import { useOpenDaily, useSettings } from './queries';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD (not UTC: "today" is the user's today). */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

/** Template variables for "now" (or a given day, e.g. a daily note's date). */
export function templateVars(title: string, day?: string): TemplateVars {
  const now = new Date();
  const date = day ? parseDate(day) : now;
  return {
    date: day ?? localDate(now),
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    weekday: date.toLocaleDateString('en', { weekday: 'long' }),
    title,
  };
}

/** A template page turned into the content and tags of a new page. */
export async function fromTemplate(templateId: string, title: string, day?: string) {
  const template = await api.get<Page>(`/pages/${templateId}`);
  return {
    content: applyTemplate(template.content, templateVars(title, day)),
    tags: template.tags.filter((t) => t !== TEMPLATE_TAG),
  };
}

export const DEFAULT_DAILY_CONTENT = '## Notes\n\n\n## Tasks\n\n- [ ] ';

/** Opens (creating if needed) the daily note for a date, using the configured template. */
export function useOpenDailyNote() {
  const settings = useSettings();
  const open = useOpenDaily();
  const navigate = useNavigate();
  return useCallback(
    async (date = localDate()) => {
      const existing = await api.get<{ date: string; pageId: string }[]>(`/daily?from=${date}&to=${date}`);
      if (existing[0]) {
        navigate(`/p/${existing[0].pageId}`);
        return;
      }
      const templateId = settings.data?.daily.templateId;
      const filled = templateId
        ? await fromTemplate(templateId, date, date).catch(() => null)
        : null;
      const { page } = await open.mutateAsync({
        date,
        content: filled?.content ?? DEFAULT_DAILY_CONTENT,
        tags: ['daily', ...(filled?.tags ?? [])],
      });
      navigate(`/p/${page.id}`);
    },
    [settings.data, open, navigate],
  );
}
