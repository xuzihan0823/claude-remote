import { createContext, useContext } from 'react';

// App 根组件提供 { tryConnect, tryConnectBases }；SettingsScreen 等经此触发重连
export const ConnActions = createContext(null);
export const useConnActions = () => useContext(ConnActions);
