import { createMMKV } from 'react-native-mmkv';

// web/core 的 api.js 在模块加载期就读 localStorage，modes.js 在调用期读写；
// MMKV 是同步 API，语义与 localStorage 对齐（AsyncStorage 不行）。
// 注意：mmkv v4 起 MMKV 只是 type 导出，运行时实例必须用 createMMKV() 工厂创建。
// 本文件必须在任何 core 模块 import 之前执行 —— 见 index.js 第一行。
export const storage = createMMKV({ id: 'claude-remote' });

if (typeof global.localStorage === 'undefined') {
  global.localStorage = {
    getItem: (k) => storage.getString(String(k)) ?? null,
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => { storage.remove(String(k)); },
    clear: () => storage.clearAll(),
    key: (i) => storage.getAllKeys()[i] ?? null,
    get length() { return storage.getAllKeys().length; },
  };
}
