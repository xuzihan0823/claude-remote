import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import * as MediaLibrary from 'expo-media-library';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { toast } from '../../../../web/core/bus.js';
import { resolveMediaLibraryAsset, toggleSelectedId } from '../../lib/attachments.js';
import { haptics } from '../../lib/haptics.js';
import { useTheme } from '../../theme.js';
import { Icon } from '../Icon.js';

const GAP = 2;
const COLS = 3;
const PAGE_SIZE = 60;
const SELECTION_LIMIT = 10;

async function getAssetFileUri(id) {
  const asset = new MediaLibrary.Asset(id);
  return asset.getUri();
}

async function convertAssetToJpeg(uriOrId) {
  const ctx = ImageManipulator.manipulate(uriOrId);
  const rendered = await ctx.renderAsync();
  try {
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    return saved?.uri || '';
  } finally {
    ctx.release?.();
    rendered.release?.();
  }
}

function FloatingGlassPill({ onPress, disabled, accessibilityLabel, testID, style, glass, accent, colors, children }) {
  const flat = StyleSheet.flatten(style) || {};
  const radius = flat.borderRadius ?? 24;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => [
        {
          borderRadius: radius,
          borderCurve: 'continuous',
          backgroundColor: accent
            ? colors.accent
            : glass
              ? 'transparent'
              : 'rgba(26, 26, 28, 0.82)',
          shadowColor: '#000000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.34,
          shadowRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.6 : pressed ? 0.84 : 1,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {glass && !accent ? (
        <GlassView
          pointerEvents="none"
          isInteractive
          glassEffectStyle="regular"
          tintColor="rgba(24, 24, 26, 0.64)"
          colorScheme="dark"
          style={[StyleSheet.absoluteFill, { borderRadius: radius, borderCurve: 'continuous' }]}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: radius,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: accent ? 'rgba(255, 255, 255, 0.32)' : 'rgba(255, 255, 255, 0.22)',
          },
        ]}
      />
      {children}
    </Pressable>
  );
}

export function PhotoGridPanel({ width, height, onBack, onAllPhotos, onConfirm }) {
  const { colors } = useTheme();
  const [assets, setAssets] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [permState, setPermState] = useState('checking'); // checking | granted | denied
  const [submitting, setSubmitting] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const assetMapRef = useRef(new Map());
  const offsetRef = useRef(0);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((v) => { if (active) setReduceTransparency(v); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const glass = Platform.OS === 'ios' && !reduceTransparency
    && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

  const fetchPage = useCallback(async (reset = false) => {
    const nextOffset = reset ? 0 : offsetRef.current;
    const rows = await new MediaLibrary.Query()
      .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.IMAGE)
      .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: false })
      .limit(PAGE_SIZE)
      .offset(nextOffset)
      .exeForMetadata();
    for (const item of rows) {
      assetMapRef.current.set(item.id, item);
    }
    offsetRef.current = nextOffset + rows.length;
    setHasMore(rows.length >= PAGE_SIZE);
    setAssets((prev) => {
      if (reset) return rows;
      const seen = new Set(prev.map((x) => x.id));
      return [...prev, ...rows.filter((x) => !seen.has(x.id))];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let perm = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        if (!perm.granted && perm.canAskAgain) {
          perm = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
        }
        if (cancelled) return;
        if (!perm.granted) {
          setPermState('denied');
          setLoading(false);
          return;
        }
        setPermState('granted');
        await fetchPage(true);
      } catch (e) {
        if (!cancelled) {
          toast(`读取相册失败：${e?.message || e}`, 'error');
          setPermState('denied');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const sub = MediaLibrary.addListener(() => {
      fetchPage(true).catch(() => {});
    });
    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore || permState !== 'granted') return;
    setLoadingMore(true);
    try {
      await fetchPage(false);
    } catch {
      // 翻页失败静默忽略，下次滚动可重试
    } finally {
      setLoadingMore(false);
    }
  }, [loading, loadingMore, hasMore, permState, fetchPage]);

  const onTogglePhoto = useCallback((id) => {
    if (submitting) return;
    setSelectedIds((prev) => {
      const { next, overLimit } = toggleSelectedId(prev, id, SELECTION_LIMIT);
      if (overLimit) {
        haptics.error();
        toast(`最多一次选择 ${SELECTION_LIMIT} 张照片`, 'info');
        return prev;
      }
      haptics.selection();
      return next;
    });
  }, [submitting]);

  const handleConfirm = useCallback(async () => {
    if (!selectedIds.length || submitting) return;
    setSubmitting(true);
    haptics.tap();
    try {
      const now = Date.now();
      const resolved = [];
      for (let i = 0; i < selectedIds.length; i++) {
        const id = selectedIds[i];
        const meta = assetMapRef.current.get(id) || { id };
        const item = await resolveMediaLibraryAsset(meta, {
          getFileUri: getAssetFileUri,
          convertToJpeg: convertAssetToJpeg,
          now: now + i,
        });
        resolved.push(item);
      }
      onConfirm(resolved);
    } catch (e) {
      haptics.error();
      toast(`照片处理失败：${e?.message || e}`, 'error');
      setSubmitting(false);
    }
  }, [selectedIds, submitting, onConfirm]);

  const cellSize = (width - GAP * (COLS - 1)) / COLS;

  const renderItem = useCallback(({ item }) => {
    const selIndex = selectedIds.indexOf(item.id);
    const isSelected = selIndex >= 0;
    return (
      <Pressable
        onPress={() => onTogglePhoto(item.id)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isSelected }}
        accessibilityLabel={item.filename || '照片'}
        style={{ width: cellSize, height: cellSize, backgroundColor: colors.bubble }}
      >
        <Image
          source={{ uri: item.id }}
          resizeMode="cover"
          style={{ width: cellSize, height: cellSize }}
        />
        {isSelected ? (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: 'rgba(0, 0, 0, 0.18)',
                borderWidth: 2.5,
                borderColor: colors.accent,
              },
            ]}
          />
        ) : null}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 7,
            right: 7,
            width: 24,
            height: 24,
            borderRadius: 12,
            backgroundColor: isSelected ? colors.accent : 'rgba(0, 0, 0, 0.28)',
            borderWidth: 1.5,
            borderColor: '#FFFFFF',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isSelected ? (
            <Text style={{ color: '#FFFFFF', fontSize: 12.5, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
              {selIndex + 1}
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  }, [cellSize, colors.accent, colors.bubble, onTogglePhoto, selectedIds]);

  return (
    <Animated.View entering={FadeIn.duration(160)} style={{ width, height }} testID="photo-grid-panel">
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.ink2} />
        </View>
      ) : permState === 'denied' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 48 }}>
          <Text style={{ color: colors.inkStrong, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
            需要访问相册才能在此预览近期照片
          </Text>
          <Text style={{ color: colors.ink2, fontSize: 13.5, marginTop: 6, textAlign: 'center', lineHeight: 19 }}>
            你也可以直接点右下角「所有照片」调用系统相册选图（无需开启权限）。
          </Text>
          <TouchableOpacity
            onPress={() => Linking.openSettings().catch(() => {})}
            accessibilityRole="button"
            style={{
              marginTop: 14,
              paddingHorizontal: 16,
              paddingVertical: 9,
              borderRadius: 18,
              borderCurve: 'continuous',
              backgroundColor: colors.controlFill,
              borderWidth: 1,
              borderColor: colors.controlBorder,
            }}
          >
            <Text style={{ color: colors.inkStrong, fontSize: 13.5, fontWeight: '500' }}>去设置开启相册权限</Text>
          </TouchableOpacity>
        </View>
      ) : assets.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 48 }}>
          <Text style={{ color: colors.ink2, fontSize: 14.5, textAlign: 'center' }}>
            暂无可预览的照片，可点右下角「所有照片」选择
          </Text>
        </View>
      ) : (
        <FlatList
          data={assets}
          keyExtractor={(item) => item.id}
          numColumns={COLS}
          renderItem={renderItem}
          extraData={selectedIds}
          columnWrapperStyle={{ gap: GAP }}
          contentContainerStyle={{ gap: GAP, paddingBottom: 76 }}
          showsVerticalScrollIndicator={false}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          removeClippedSubviews={Platform.OS === 'android'}
          initialNumToRender={15}
          maxToRenderPerBatch={18}
          windowSize={5}
        />
      )}

      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 14,
          right: 14,
          bottom: 14,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <FloatingGlassPill
          onPress={() => { haptics.tap(); onBack(); }}
          disabled={submitting}
          accessibilityLabel="返回附件菜单"
          testID="photo-grid-back"
          glass={glass}
          colors={colors}
          style={{ width: 48, height: 48, borderRadius: 24 }}
        >
          <Icon name="back" size={22} color="#FFFFFF" strokeWidth={2.2} />
        </FloatingGlassPill>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <FloatingGlassPill
            onPress={() => { haptics.tap(); onAllPhotos(); }}
            disabled={submitting}
            accessibilityLabel="所有照片"
            testID="photo-grid-all-photos"
            glass={glass}
            colors={colors}
            style={{ height: 48, borderRadius: 24, paddingHorizontal: 22 }}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 16.5, fontWeight: '600' }}>所有照片</Text>
          </FloatingGlassPill>

          {selectedIds.length > 0 ? (
            <FloatingGlassPill
              onPress={handleConfirm}
              disabled={submitting}
              accessibilityLabel={`添加已选的 ${selectedIds.length} 张照片`}
              testID="photo-grid-confirm"
              glass={glass}
              accent
              colors={colors}
              style={{ height: 48, borderRadius: 24, paddingHorizontal: 18, minWidth: 88 }}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
                  {`添加 (${selectedIds.length})`}
                </Text>
              )}
            </FloatingGlassPill>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}
