import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connHost, fetchSessions } from '../../../web/core/api.js';
import { useBus } from '../../../web/core/bus.js';
import { ws } from '../../../web/core/ws.js';
import { useTheme } from '../theme.js';
import { Spark } from './Spark.js';
import { cwdTail, relTime, statusColor } from '../lib/format.js';

// 移植自 web/ui/components/sidebar.js：最近会话列表 + 新对话/设置入口 + WS 实时状态点 + 连接状态脚注。
export function DrawerContent({ navigation }) {
  const { colors, fonts } = useTheme();
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
      // unauthorized 由全局 bus 处理（App.js 弹回 ConnectScreen），这里静默
      if (e.code !== 'unauthorized') {
        setError(e.code === 'network_error' ? '网络不可达' : `加载失败：${e.code}`);
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t1 = setInterval(() => load(true), 30_000);
    // 30s tick 驱动 relTime 重渲染（web 同款）
    const t2 = setInterval(() => setTick((x) => x + 1), 30_000);
    // RN 无 visibilitychange，用 AppState 'active' 对应
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

  // 跳转后关闭抽屉
  const go = (fn) => () => { fn(); navigation.closeDrawer(); };
  const goNew = go(() => navigation.navigate('Main', { screen: 'Home' }));
  const goSettings = go(() => navigation.navigate('Main', { screen: 'Settings' }));
  const goChat = (sessionId) => go(() => navigation.navigate('Main', { screen: 'Chat', params: { sessionId } }));

  const renderItem = ({ item: s }) => {
    const dot = statusColor(colors, s.status) || colors.ink3;
    return (
      <TouchableOpacity
        onPress={goChat(s.sessionId)}
        style={{ paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ flex: 1, color: colors.ink, fontSize: 15 }}
          >
            {s.title || '(空会话)'}
          </Text>
          <View style={{ width: 8, height: 8, borderRadius: 4, marginLeft: 8, backgroundColor: dot }} />
        </View>
        <Text numberOfLines={1} style={{ marginTop: 2, color: colors.ink2, fontSize: 12 }}>
          {cwdTail(s.cwd)} · {relTime(s.lastActiveAt)}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg2, paddingTop: insets.top + 12 }}>
      {/* 品牌行 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8 }}>
        <Spark size={18} />
        <Text style={{ marginLeft: 8, color: colors.inkStrong, fontFamily: fonts.serif, fontSize: 18 }}>
          Claude Remote
        </Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          onPress={() => load()}
          accessibilityLabel="刷新"
          accessibilityRole="button"
          style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}
        >
          {loading
            ? <ActivityIndicator size="small" color={colors.ink2} />
            : <Text style={{ color: colors.ink2, fontSize: 18 }}>⟳</Text>}
        </TouchableOpacity>
      </View>

      {/* 导航项 */}
      <View style={{ paddingHorizontal: 16 }}>
        <TouchableOpacity
          onPress={goNew}
          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}
        >
          <Text style={{ width: 24, textAlign: 'center', color: colors.accent, fontSize: 18 }}>＋</Text>
          <Text style={{ marginLeft: 8, color: colors.inkStrong, fontSize: 16 }}>新对话</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={goSettings}
          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}
        >
          <Text style={{ width: 24, textAlign: 'center', color: colors.ink2, fontSize: 18 }}>⚙</Text>
          <Text style={{ marginLeft: 8, color: colors.inkStrong, fontSize: 16 }}>设置</Text>
        </TouchableOpacity>
      </View>

      <Text style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, color: colors.ink3, fontSize: 12 }}>
        最近对话
      </Text>

      <FlatList
        data={sorted}
        keyExtractor={(s) => s.sessionId}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 4, flexGrow: 1 }}
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

      {/* 连接状态脚注 */}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        paddingHorizontal: 16, paddingTop: 12,
        paddingBottom: Math.max(insets.bottom, 12),
        borderTopWidth: 1, borderTopColor: colors.line,
      }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, marginRight: 8, backgroundColor: connDotColor }} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink2, fontFamily: fonts.mono, fontSize: 12 }}>
          {connHost()}
        </Text>
      </View>
    </View>
  );
}
