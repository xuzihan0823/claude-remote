import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connHost, fetchSessions } from '../../../web/core/api.js';
import { useBus } from '../../../web/core/bus.js';
import { ws } from '../../../web/core/ws.js';
import { useTheme } from '../theme.js';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { Spark } from './Spark.js';
import { cwdTail, relTime, statusColor } from '../lib/format.js';

// 侧栏抽屉：顶部品牌 + 液态玻璃刷新按钮，中部最近对话列表，底部悬浮液态玻璃操作栏（左侧设置与连接状态 + 右侧新对话胶囊按钮）。
export function DrawerContent({ navigation }) {
  const { colors, dark, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState({ sessions: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [, setTick] = useState(0);
  const [wsPhase, setWsPhase] = useState(ws.state.phase);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await fetchSessions(100));
      setError('');
    } catch (e) {
      if (e.code !== 'unauthorized') {
        setError(e.code === 'network_error' ? '网络不可达' : `加载失败：${e.code}`);
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t1 = setInterval(() => load(true), 30_000);
    const t2 = setInterval(() => setTick((x) => x + 1), 30_000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') load(true); });
    return () => { clearInterval(t1); clearInterval(t2); sub.remove(); };
  }, [load]);

  useBus('ws-open', () => load(true), [load]);
  useBus('ws:status', ({ sessionId, status }) => {
    setData((d) => ({ ...d, sessions: d.sessions.map((s) => (s.sessionId === sessionId ? { ...s, status } : s)) }));
  }, []);
  useBus('ws-state', (s) => setWsPhase(s.phase), []);

  const sorted = useMemo(
    () => [...data.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [data],
  );

  const connDotColor = wsPhase === 'open' ? colors.ok : wsPhase === 'connecting' ? colors.warn : colors.danger;
  const bottomBarOffset = Math.max(insets.bottom, 14);

  const go = (fn) => () => { fn(); navigation.closeDrawer(); };
  const goNew = go(() => navigation.navigate('Main', { screen: 'Home' }));
  const goSettings = go(() => navigation.navigate('Main', { screen: 'Settings' }));
  const goChat = (sessionId) => go(() => navigation.navigate('Main', { screen: 'Chat', params: { sessionId } }));

  const renderItem = ({ item: s }) => {
    const dot = statusColor(colors, s.status) || colors.ink3;
    return (
      <Pressable
        onPress={goChat(s.sessionId)}
        accessibilityRole="button"
        accessibilityLabel={`${s.title || '空会话'}，${cwdTail(s.cwd)}，${relTime(s.lastActiveAt)}`}
        style={({ pressed }) => ({
          paddingVertical: 11,
          paddingHorizontal: 12,
          borderRadius: 14,
          borderCurve: 'continuous',
          backgroundColor: pressed ? colors.glassPressed : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ flex: 1, color: colors.inkStrong, fontSize: 15, letterSpacing: -0.1 }}
          >
            {s.title || '(空会话)'}
          </Text>
          <View style={{ width: 8, height: 8, borderRadius: 4, marginLeft: 10, backgroundColor: dot }} />
        </View>
        <Text numberOfLines={1} style={{ marginTop: 3, color: colors.ink2, fontSize: 12.5 }}>
          {cwdTail(s.cwd)} · {relTime(s.lastActiveAt)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2, paddingTop: insets.top + 8 }}>
      {/* 品牌与液态玻璃刷新按钮 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10 }}>
        <Spark size={20} />
        <Text style={{ marginLeft: 9, color: colors.inkStrong, fontFamily: fonts.serif, fontSize: 19, letterSpacing: -0.3 }}>
          Claude Remote
        </Text>
        <View style={{ flex: 1 }} />
        <GlassSurface interactive variant="pill" style={{ borderRadius: 22 }}>
          <Pressable
            onPress={() => load()}
            accessibilityLabel="刷新会话列表"
            accessibilityRole="button"
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? colors.glassPressed : 'transparent',
            })}
          >
            {loading
              ? <ActivityIndicator size="small" color={colors.ink2} />
              : <Icon name="refresh" size={18} color={colors.ink} />}
          </Pressable>
        </GlassSurface>
      </View>

      {/* 分组标题 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 4, paddingBottom: 6 }}>
        <Text style={{ color: colors.ink3, fontSize: 12.5, fontWeight: '500' }}>
          最近对话
        </Text>
        {sorted.length > 0 ? (
          <Text style={{ color: colors.ink3, fontFamily: fonts.mono, fontSize: 11.5 }}>
            {sorted.length}
          </Text>
        ) : null}
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(s) => s.sessionId}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 8,
          paddingTop: 2,
          paddingBottom: bottomBarOffset + 74,
          flexGrow: 1,
        }}
        ListEmptyComponent={
          error ? (
            <TouchableOpacity onPress={() => load()} style={{ padding: 16 }}>
              <Text style={{ color: colors.danger, fontSize: 13, textAlign: 'center' }}>
                {error} · 点击重试
              </Text>
            </TouchableOpacity>
          ) : loading ? null : (
            <Text style={{ padding: 16, color: colors.ink3, fontSize: 13, textAlign: 'center' }}>
              没有会话
            </Text>
          )
        }
        ListFooterComponent={
          data.total > sorted.length ? (
            <Text style={{ padding: 12, color: colors.ink3, fontSize: 12, textAlign: 'center' }}>
              已显示 {sorted.length} / {data.total} 个会话
            </Text>
          ) : null
        }
      />

      {/* 底部悬浮液态玻璃操作栏：左侧设置与连接状态胶囊 + 右侧新对话胶囊 */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: bottomBarOffset,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <GlassSurface interactive variant="pill" style={{ flex: 1, minWidth: 0, borderRadius: 25 }}>
          <Pressable
            onPress={goSettings}
            accessibilityRole="button"
            accessibilityLabel={`设置，当前连接 ${connHost()}`}
            style={({ pressed }) => ({
              height: 50,
              borderRadius: 25,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: pressed ? colors.glassPressed : 'transparent',
            })}
          >
            <Icon name="settings" size={19} color={colors.ink} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ color: colors.inkStrong, fontSize: 14, fontWeight: '600' }}>
                  设置
                </Text>
                <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: connDotColor }} />
              </View>
              <Text
                numberOfLines={1}
                ellipsizeMode="middle"
                style={{ color: colors.ink2, fontFamily: fonts.mono, fontSize: 10.5, marginTop: 1 }}
              >
                {connHost()}
              </Text>
            </View>
          </Pressable>
        </GlassSurface>

        <GlassSurface interactive variant="accent" style={{ borderRadius: 25 }}>
          <Pressable
            onPress={goNew}
            accessibilityRole="button"
            accessibilityLabel="新对话"
            style={({ pressed }) => ({
              height: 50,
              borderRadius: 25,
              paddingHorizontal: 16,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              backgroundColor: pressed ? colors.glassPressed : 'transparent',
            })}
          >
            <Icon name="plus" size={18} strokeWidth={2.1} color={dark ? colors.accent : colors.accentDeep} />
            <Text style={{ color: dark ? colors.inkStrong : colors.accentDeep, fontSize: 15, fontWeight: '600' }}>
              新对话
            </Text>
          </Pressable>
        </GlassSurface>
      </View>
    </View>
  );
}
