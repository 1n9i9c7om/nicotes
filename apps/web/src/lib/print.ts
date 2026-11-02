/**
 * Printing a page (or saving it as PDF through the print dialog). The print stylesheet hides
 * the app around the page; parts that need work first, like a canvas turned into a vector
 * drawing, register a preparer that runs before the dialog opens.
 */

type Preparer = () => Promise<(() => void) | void>;

const preparers = new Set<Preparer>();

/** Registers work to do before printing; it may return a clean-up for afterwards. */
export function onPreparePrint(prepare: Preparer): () => void {
  preparers.add(prepare);
  return () => preparers.delete(prepare);
}

/** Prepares, then opens the browser's print dialog with `title` as the document (PDF) name. */
export async function printPage(title: string) {
  const cleanups = (await Promise.all([...preparers].map((p) => p().catch(() => undefined)))).filter(Boolean) as (() => void)[];
  const previous = document.title;
  document.title = title;
  const restore = () => {
    document.title = previous;
    for (const cleanup of cleanups) cleanup();
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
