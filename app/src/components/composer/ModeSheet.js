import { useEffect, useRef } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { PERMISSION_MODES } from '../../../../web/core/modes.js';
import { useTheme } from '../../theme.js';

// 权限模式 sheet：四模式（标准/自动编辑/规划/Bypass）+ 副行说明照抄 web。
// 从非 bypass 切到 bypass 时 Alert.alert 二次确认（destructive）。
// 对应 web/ui/components/mode-sheet.js 的 ModeSheet。受控：open 由父层切换。
const MODE_LABELS = { default: '标准', acceptEdits: '自动编辑', plan: '规划', bypassPermissions: 'Bypass' };
const MODE_SUBS = {
  default: '逐项审批（默认）',
  acceptEdits: '自动同意文件编辑',
  plan: '只读规划模式',
  bypassPermissions: '全自动，危险',
};
const BYPASS_CONFIRM_TEXT =
  'Claude 将不再请求任何审批，直接执行所有操作（含文件修改与命令执行）。仅在完全信任当前任务时使用。';

const renderBackdrop = (props) => (
  <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
);

export function ModeSheet({ open, mode, onSelect, onClose }) {
  const { colors } = useTheme();
  const ref = useRef(null);

  useEffect(() => {
    if (open) ref.current?.present();
  }, [open]);

  const pick = (m) => {
    // 已处于 bypass 时再点 bypass 不再确认；从其它模式切入才拦
    if (m === 'bypassPermissions' && mode !== 'bypassPermissions') {
      Alert.alert('启用 Bypass 模式？', BYPASS_CONFIRM_TEXT, [
        { text: '取消', style: 'cancel' },
        { text: '启用', style: 'destructive', onPress: () => { onSelect('bypassPermissions'); ref.current?.dismiss(); } },
      ], { cancelable: true });
      return;
    }
    onSelect(m);
    ref.current?.dismiss();
  };

  const renderHandle = () => (
    <View style={{ alignItems: 'center', paddingVertical: 8 }}>
      <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.ink3 }} />
    </View>
  );

  const row = { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16 };
  const main = { color: colors.inkStrong, fontSize: 15 };

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      maxDynamicContentSize={460}
      backdropComponent={renderBackdrop}
      handleComponent={renderHandle}
      onDismiss={() => onClose?.()}
      backgroundStyle={{ backgroundColor: colors.card }}
    >
      <BottomSheetView style={{ paddingBottom: 16 }}>
        <View style={{ alignItems: 'center', paddingVertical: 6 }}>
          <Text style={{ color: colors.ink2, fontSize: 13 }}>权限模式</Text>
        </View>
        {PERMISSION_MODES.map((m) => {
          const on = mode === m;
          return (
            <TouchableOpacity key={m} onPress={() => pick(m)} style={row}>
              <View style={{ flex: 1 }}>
                <Text style={main}>{MODE_LABELS[m]}</Text>
                <Text style={{ color: colors.ink2, fontSize: 12, marginTop: 2 }}>{MODE_SUBS[m]}</Text>
              </View>
              {on ? <Text style={{ color: colors.accent, fontSize: 16, marginLeft: 8 }}>✓</Text> : null}
            </TouchableOpacity>
          );
        })}
      </BottomSheetView>
    </BottomSheetModal>
  );
}
