import { createContext, useContext } from 'react';

// reselect(preference) 试连成功后保存偏好；省略 preference 时按当前偏好自动重选。
export const ConnActions = createContext(null);
export const useConnActions = () => useContext(ConnActions);
