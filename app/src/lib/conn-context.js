import { createContext, useContext } from 'react';

// App 根组件提供 { tryConnect, tryConnectBases, switchDevice, reselect }；设置页经此触发重连、切换设备、按通道偏好重新选地址
export const ConnActions = createContext(null);
export const useConnActions = () => useContext(ConnActions);
