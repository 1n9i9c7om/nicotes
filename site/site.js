// Landing page: the copy button, and the Firefox install button when Pages hosts a signed
// extension (the pages job writes updates.json next to this file).

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = document.querySelector(button.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => (button.textContent = 'Copy'), 2000);
  });
}

const firefox = document.querySelector('[data-firefox]');
fetch('updates.json')
  .then((res) => (res.ok ? res.json() : null))
  .then((manifest) => {
    const addon = manifest && Object.values(manifest.addons ?? {})[0];
    const latest = addon?.updates?.at(-1);
    if (!latest?.update_link) return;
    firefox.href = latest.update_link;
    firefox.textContent = `Add to Firefox · ${latest.version}`;
    firefox.hidden = false;
  })
  .catch(() => {});
