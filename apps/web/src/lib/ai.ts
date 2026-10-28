import { AI_PROVIDER_LABELS, providerOf, type AiTask, type Settings } from '@nicotes/shared';

/** The model an AI feature uses: its own, else the default model. */
export const modelFor = (settings: Settings, task: AiTask) => settings.models[task].model ?? settings.openrouter.model;

/**
 * Whether the service running a feature's model has an API key, and if not the message to
 * show, e.g. "Asking needs a Routeway API key — add one under Settings."
 */
export function aiKeyFor(settings: Settings | undefined, task: AiTask, what: string) {
  if (!settings) return { ready: false, message: null };
  const provider = providerOf(modelFor(settings, task));
  const ready = provider === 'routeway' ? settings.routeway.apiKeySet : settings.openrouter.apiKeySet;
  const article = provider === 'routeway' ? 'a' : 'an';
  return { ready, message: ready ? null : `${what} needs ${article} ${AI_PROVIDER_LABELS[provider]} API key — add one under Settings.` };
}
