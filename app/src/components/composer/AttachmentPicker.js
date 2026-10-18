import { ActionSheetIOS, TouchableOpacity } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { toast } from '../../../../web/core/bus.js';
import { Icon } from '../Icon.js';
import { useTheme } from '../../theme.js';

// + 按钮：弹 iOS ActionSheet 选 拍照/相册/文件，归一为 {uri,name,size} 列表回调 onPicked。
// 相机权限串 P3 才进 Info.plist；launchCameraAsync 失败时 toast 提示暂不可用。
// picker 返回值均 guard canceled 与空 assets（image-picker: {assets, canceled}；
// document-picker: {assets, canceled}）。ActionSheetIOS 仅 iOS 可用（本项目目标平台）。
export function AttachmentPicker({ disabled, onPicked }) {
  const { colors } = useTheme();

  const addAssets = (assets) => {
    if (!assets || !assets.length) return;
    const items = assets.map((a) => ({
      uri: a.uri,
      name: a.name || a.fileName || (a.uri ? String(a.uri).split('/').pop() : 'file'),
      size: a.size ?? a.fileSize ?? 0,
    }));
    onPicked(items);
  };

  const pickCamera = async () => {
    try {
      const r = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images });
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch {
      toast('相机暂不可用', 'error');
    }
  };

  const pickLibrary = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
      });
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch {
      toast('相册暂不可用', 'error');
    }
  };

  const pickFiles = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch {
      toast('文件选择暂不可用', 'error');
    }
  };

  const openSheet = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['拍照', '从相册选择', '选择文件', '取消'],
        cancelButtonIndex: 3,
      },
      (idx) => {
        if (idx === 0) pickCamera();
        else if (idx === 1) pickLibrary();
        else if (idx === 2) pickFiles();
      },
    );
  };

  return (
    <TouchableOpacity
      onPress={openSheet}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel="上传附件"
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.controlFill,
        borderWidth: 1,
        borderColor: colors.controlBorder,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon name="plus" />
    </TouchableOpacity>
  );
}
