import { useRef } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal } from '@gorhom/bottom-sheet';
import { findModel, modelMainName, resolveDefaultName } from '../../../../web/core/api.js';
import { ModelSheetContent } from './ModelSheet.js';
import { useTheme } from '../../theme.js';

// pill：选中显示 modelMainName，未选显示「默认 · defName」；点开 BottomSheetModal 选模型。
// 对应 web/ui/components/model-picker.js 的 ModelPicker。
const renderBackdrop = (props) => (
  <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
);

export function ModelPicker({ value, onChange, catalog }) {
  const { colors } = useTheme();
  const ref = useRef(null);
  const { models = [] } = catalog || {};
  const sel = findModel(models, value);
  const defName = resolveDefaultName(catalog);
  const triggerMain = sel ? modelMainName(sel) : `默认${defName ? ` · ${defName}` : ''}`;
  const pick = (v) => { onChange(v); ref.current?.dismiss(); };

  const renderHandle = () => (
    <View style={{ alignItems: 'center', paddingVertical: 8 }}>
      <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.ink3 }} />
    </View>
  );

  return (
    <>
      <TouchableOpacity
        onPress={() => ref.current?.present()}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: colors.bubble,
          borderRadius: 12,
          paddingHorizontal: 10,
          paddingVertical: 4,
          maxWidth: 220,
        }}
      >
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 12, flexShrink: 1 }}>{triggerMain}</Text>
        <Text style={{ color: colors.ink2, fontSize: 10, marginLeft: 4 }}>⌄</Text>
      </TouchableOpacity>
      <BottomSheetModal
        ref={ref}
        enableDynamicSizing
        maxDynamicContentSize={600}
        backdropComponent={renderBackdrop}
        handleComponent={renderHandle}
        backgroundStyle={{ backgroundColor: colors.card }}
      >
        <ModelSheetContent value={value} catalog={catalog} onPick={pick} />
      </BottomSheetModal>
    </>
  );
}
