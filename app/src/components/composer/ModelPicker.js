import { useRef } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetBackdrop, BottomSheetModal } from '@gorhom/bottom-sheet';
import { modelSelection, modelTriggerLabel } from '../../../../web/core/api.js';
import { effortSelection, modelEffortTriggerLabel } from '../../../../web/core/effort.js';
import { ModelSheetContent } from './ModelSheet.js';
import { useTheme } from '../../theme.js';

// pill：展示当前模型及思考程度（选中 / 跟随默认 / 不可用 / 需重选）；
// 点开 BottomSheetModal 选择模型与思考程度，选模型后弹层保留以便继续选择思考档位。
const renderBackdrop = (props) => (
  <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
);

export function ModelPicker({
  value,
  onChange,
  catalog,
  effortRecord,
  onEffortChange,
  capabilities,
  onOpen,
  onRefreshCapabilities,
}) {
  const { colors } = useTheme();
  const ref = useRef(null);
  const triggerMain = modelTriggerLabel(catalog, value);
  const modelUnavailable = modelSelection(catalog, value).status === 'unavailable';
  const effortState = effortSelection(capabilities, effortRecord, { model: value });
  const effortHasIssue = !effortState.canSend;
  const fullLabel = modelEffortTriggerLabel(catalog, value, capabilities, effortRecord, { model: value });

  const openSheet = () => {
    onOpen?.();
    ref.current?.present();
  };

  const pickModel = (v) => {
    onChange(v);
    if (!onEffortChange) {
      ref.current?.dismiss();
    }
  };

  const renderHandle = () => (
    <View style={{ alignItems: 'center', paddingVertical: 8 }}>
      <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.ink3 }} />
    </View>
  );

  return (
    <>
      <TouchableOpacity
        testID="model-picker-trigger"
        onPress={openSheet}
        accessibilityRole="button"
        accessibilityLabel={`选择模型与思考程度，当前${fullLabel}`}
        style={{
          borderRadius: 22,
          borderCurve: 'continuous',
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 44,
          justifyContent: 'center',
          backgroundColor: modelUnavailable || effortHasIssue ? colors.glassTintAccent : colors.controlFill,
          borderWidth: 1,
          borderColor: modelUnavailable || effortHasIssue ? colors.danger : colors.controlBorder,
          flexShrink: 1,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            color: modelUnavailable ? colors.danger : colors.ink,
            fontSize: 13.5,
            fontWeight: '500',
          }}
        >
          {triggerMain}
          {effortState.badge ? (
            <Text
              style={{
                color: effortHasIssue ? colors.danger : colors.accent,
                fontWeight: '600',
              }}
            >
              {` · ${effortState.badge}`}
            </Text>
          ) : null}
        </Text>
      </TouchableOpacity>
      <BottomSheetModal
        ref={ref}
        enableDynamicSizing
        maxDynamicContentSize={640}
        backdropComponent={renderBackdrop}
        handleComponent={renderHandle}
        backgroundStyle={{ backgroundColor: colors.card }}
      >
        <ModelSheetContent
          value={value}
          catalog={catalog}
          onPick={pickModel}
          effortRecord={effortRecord}
          capabilities={capabilities}
          onPickEffort={onEffortChange}
          onRefreshCapabilities={onRefreshCapabilities}
          onClose={() => ref.current?.dismiss()}
        />
      </BottomSheetModal>
    </>
  );
}
