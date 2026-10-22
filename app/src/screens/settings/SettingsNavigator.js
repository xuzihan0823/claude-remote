import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../../theme.js';
import { sheetBg } from './ui.js';
import { SettingsHome } from './SettingsHome.js';
import { DevicesScreen } from './DevicesScreen.js';
import { DeviceDetailScreen } from './DeviceDetailScreen.js';
import { AddDeviceScreen } from './AddDeviceScreen.js';
import { AppearanceScreen } from './AppearanceScreen.js';
import { FontSizeScreen } from './FontSizeScreen.js';
import { DefaultModelScreen } from './DefaultModelScreen.js';
import { PermissionModeScreen } from './PermissionModeScreen.js';
import { QuickStartScreen } from './QuickStartScreen.js';

const Stack = createNativeStackNavigator();

// 设置以 sheet（presentation: 'modal'）弹出，内部再是一层 stack：首页 → 各子页 push。
export function SettingsNavigator() {
  const { colors, dark } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: sheetBg(colors, dark) } }}>
      <Stack.Screen name="SettingsHome" component={SettingsHome} />
      <Stack.Screen name="Devices" component={DevicesScreen} />
      <Stack.Screen name="DeviceDetail" component={DeviceDetailScreen} />
      <Stack.Screen name="AddDevice" component={AddDeviceScreen} />
      <Stack.Screen name="Appearance" component={AppearanceScreen} />
      <Stack.Screen name="FontSize" component={FontSizeScreen} />
      <Stack.Screen name="DefaultModel" component={DefaultModelScreen} />
      <Stack.Screen name="PermissionMode" component={PermissionModeScreen} />
      <Stack.Screen name="QuickStart" component={QuickStartScreen} />
    </Stack.Navigator>
  );
}
