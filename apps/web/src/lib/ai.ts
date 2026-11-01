import { AI_PROVIDER_LABELS, providerOf, type AiProvider, type AiTask, type Settings } from '@nicotes/shared';

/** The model an AI feature uses: its own, else the default model. */
export const modelFor = (settings: Settings, task: AiTask) => settings.models[task].model ?? settings.openrouter.model;

/** Whether the service that runs `model` is set up: a key for the hosted ones, an address for your own server. */
export function serviceReady(settings: Settings, model: string) {
  const provider: AiProvider = providerOf(model);
  if (provider === 'local') return settings.local.url !== null;
  return provider === 'routeway' ? settings.routeway.apiKeySet : settings.openrouter.apiKeySet;
}

/**
 * Whether the service running a feature's model is set up, and if not the message to show,
 * e.g. "Asking needs a Routeway API key — add one under Settings."
 */
export function aiKeyFor(settings: Settings | undefined, task: AiTask, what: string) {
  if (!settings) return { ready: false, message: null };
  const model = modelFor(settings, task);
  const provider = providerOf(model);
  const ready = serviceReady(settings, model);
  if (ready) return { ready, message: null };
  if (provider === 'local') return { ready, message: `${what} needs the address of your own model server — add it under Settings.` };
  const article = provider === 'routeway' ? 'a' : 'an';
  return { ready, message: `${what} needs ${article} ${AI_PROVIDER_LABELS[provider]} API key — add one under Settings.` };
}
