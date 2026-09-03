// metro.config.js 把 web/vendor/preact-htm-standalone.module.js 重定向到本文件：
// core/bus.js 只从中取 useEffect（useBus 用），RN 端由 react 提供同名实现。
export { useEffect } from 'react';
