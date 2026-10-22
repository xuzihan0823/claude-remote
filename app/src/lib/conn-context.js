import { createContext, useContext } from 'react';

// App 根组件提供 { tryConnect, tryConnectBases, switchDevice }；设置页经此触发重连、切换设备（switchDevice）
export const ConnActions = createContext(null);
export const useConnActions = () => useContext(ConnActions);
