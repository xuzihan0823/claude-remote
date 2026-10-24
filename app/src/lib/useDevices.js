import { useEffect, useState } from 'react';
import { bus } from '../../../web/core/bus.js';
import { currentDeviceId, sortedDevices } from '../../../web/core/devices.js';

// 设备列表 + 当前设备 id；任何地方改了设备后 bus.emit('devices') 即可刷新。
export function useDevices() {
  const read = () => ({ list: sortedDevices(), current: currentDeviceId() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const off = bus.on('devices', () => setState(read()));
    setState(read());
    return () => { off(); };
  }, []);
  return state;
}
