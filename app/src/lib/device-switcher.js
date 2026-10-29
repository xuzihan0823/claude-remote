import { ActionSheetIOS, Alert, Platform } from 'react-native';

/**
 * 快速切换设备的系统菜单：每台设备一项（当前设备带 ✓ 且禁用）+「管理设备…」。
 * onPick(id) 切换；onManage() 打开设置 → 设备。
 */
export function showDeviceSwitcher({ list, current, onPick, onManage }) {
  const names = list.map((d) => (d.id === current ? `✓ ${d.name}` : d.name));
  const options = [...names, '管理设备…', '取消'];
  const handle = (i) => {
    if (i < list.length) { if (list[i].id !== current) onPick(list[i].id); return; }
    if (i === list.length) onManage();
  };
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions({
      title: '切换设备',
      options,
      cancelButtonIndex: options.length - 1,
      disabledButtonIndices: list.map((d, i) => (d.id === current ? i : -1)).filter((i) => i >= 0),
    }, handle);
    return;
  }
  Alert.alert('切换设备', undefined, [
    ...list.filter((d) => d.id !== current).map((d) => ({ text: d.name, onPress: () => onPick(d.id) })),
    { text: '管理设备…', onPress: onManage },
    { text: '取消', style: 'cancel' },
  ]);
}
