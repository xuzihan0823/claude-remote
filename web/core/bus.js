import { useEffect } from '../vendor/preact-htm-standalone.module.js';

export const bus = {
  m: new Map(),
  on(type, fn) {
    if (!this.m.has(type)) this.m.set(type, new Set());
    this.m.get(type).add(fn);
    return () => this.m.get(type)?.delete(fn);
  },
  emit(type, data) { this.m.get(type)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};

export function useBus(type, fn, deps) { useEffect(() => bus.on(type, fn), deps); }

export function toast(text, kind = 'info') {
  bus.emit('toast', { id: Math.random().toString(36).slice(2), text, kind });
}
