import { html, useState } from '../../vendor/preact-htm-standalone.module.js';
import { useBus } from '../../core/bus.js';

export function ToastLayer() {
  const [items, setItems] = useState([]);
  useBus('toast', (t) => {
    setItems((xs) => [...xs, t]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3200);
  }, []);
  return html`<div class="toasts">${items.map((t) => html`<div key=${t.id} class="toast ${t.kind}">${t.text}</div>`)}</div>`;
}
