import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;

/**
 * Target of the PWA share sheet (`/share?title=&text=&url=`). Android apps often put the
 * link into `text` (sometimes with a headline), so look there too.
 */
export function SharePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    const title = params.get('title') ?? '';
    const text = params.get('text') ?? '';
    const url = params.get('url') || URL_IN_TEXT.exec(text)?.[0] || URL_IN_TEXT.exec(title)?.[0];
    const next = url
      ? `/import?url=${encodeURIComponent(url.replace(/[).,;]+$/, ''))}`
      : `/import?text=${encodeURIComponent([title, text].filter(Boolean).join('\n\n'))}`;
    navigate(next, { replace: true });
  }, [params, navigate]);

  return null;
}
