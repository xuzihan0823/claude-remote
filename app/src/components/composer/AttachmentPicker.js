import { ActionSheetIOS, Alert, Linking, TouchableOpacity } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { toast } from '../../../../web/core/bus.js';
import { Icon } from '../Icon.js';
import { MAX_UPLOAD_BYTES, normalizeAsset } from '../../lib/attachments.js';
import { useTheme } from '../../theme.js';

// + 按钮：弹 iOS ActionSheet 选 拍照/相册/文件，归一为 {uri,name,size,isImage} 列表回调 onPicked。
// 相机先申请权限，被拒时引导去设置；超过 25MB 的在选择时就跳过，不等上传失败。
// picker 返回值均 guard canceled 与空 assets（image-picker: {assets, canceled}；
// document-picker: {assets, canceled}）。ActionSheetIOS 仅 iOS 可用（本项目目标平台）。
export function AttachmentPicker({ disabled, onPicked }) {
  const { colors } = useTheme();

  const addAssets = (assets) => {
    if (!assets || !assets.length) return;
    const items = assets.map((a) => normalizeAsset(a));
    const ok = items.filter((f) => !(f.size > MAX_UPLOAD_BYTES));
    const big = items.length - ok.length;
    if (big) toast(`${big} 个文件超过 25MB，已跳过`, 'error');
    if (ok.length) onPicked(ok);
  };

  const askSettings = (what) => {
    Alert.alert(`没有${what}权限`, `请在「设置」里允许 Claude Remote 访问${what}。`, [
      { text: '取消', style: 'cancel' },
      { text: '去设置', onPress: () => Linking.openSettings().catch(() => {}) },
    ]);
  };

  // 选图统一要「兼容」格式：iOS 会把 HEIC 转成 JPEG，Claude 的 Read 不认 HEIC
  const imageOpts = {
    mediaTypes: ['images'],
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode?.Compatible ?? 'compatible',
    quality: 0.85,
    exif: false,
  };

  const pickCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { askSettings('相机'); return; }
      const r = await ImagePicker.launchCameraAsync(imageOpts);
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch (e) {
      toast(`相机打开失败：${e?.message || e}`, 'error');
    }
  };

  const pickLibrary = async () => {
    try {
      // iOS 14+ 走系统 PHPicker，无需相册授权
      const r = await ImagePicker.launchImageLibraryAsync({ ...imageOpts, allowsMultipleSelection: true, selectionLimit: 10 });
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch (e) {
      toast(`相册打开失败：${e?.message || e}`, 'error');
    }
  };

  const pickFiles = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch (e) {
      toast(`文件选择失败：${e?.message || e}`, 'error');
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
