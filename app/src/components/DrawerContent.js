import { useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBus } from '../../../web/core/bus.js';
import { ws } from '../../../web/core/ws.js';
import { useTheme } from '../theme.js';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { Spark } from './Spark.js';
import { relTime, STATUS_LABEL, statusColor } from '../lib/format.js';
import { useProjects } from '../lib/projects-context.js';
import { shortPath } from '../lib/projects.js';
import { useProjectSessionGroups } from '../lib/use-project-session-groups.js';
import { useSessionSearch } from '../lib/use-session-search.js';
import { useConnActions } from '../lib/conn-context.js';
import { useDevices } from '../lib/useDevices.js';
import { showDeviceSwitcher } from '../lib/device-switcher.js';
import { MATCH_LABEL } from '../../../web/core/search.js';

/** 片段中高亮命中词（大小写不敏感）。 */
function Highlight({ text, query, style, hlStyle }) {
  const q = query.trim().toLowerCase();
  const idx = q ? text.toLowerCase().indexOf(q) : -1;
  if (idx < 0 || text.toLowerCase().length !== text.length) return <Text numberOfLines={2} style={style}>{text}</Text>;
  return (
    <Text numberOfLines={2} style={style}>
      {text.slice(0, idx)}<Text style={hlStyle}>{text.slice(idx, idx + q.length)}</Text>{text.slice(idx + q.length)}
    </Text>
  );
}

export function DrawerContent({ navigation, state }) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const list = useProjectSessionGroups(state);
  const search = useSessionSearch();
  const [query, setQueryText] = useState('');
  const searching = query.trim() !== '';
  const onQuery = (q) => { setQueryText(q); search.setQuery(q); };
  const [wsPhase, setWsPhase] = useState(ws.state.phase);
  useBus('ws-state', (s) => setWsPhase(s.phase), []);

  const connDotColor = wsPhase === 'open' ? colors.ok : wsPhase === 'connecting' ? colors.warn : colors.danger;
  const bottomBarOffset = Math.max(insets.bottom, 14);

  const go = (fn) => () => { fn(); navigation.closeDrawer(); };
  const goNew = go(() => { projects.prepareNewChat(); navigation.navigate('Main', { screen: 'Home', pop: true }); });
  const goSettings = go(() => navigation.navigate('Main', { screen: 'Settings' }));
  // 当前设备名显示在设置胶囊里；有多台时左边多一个圆钮，点开系统菜单快速切换
  const { switchDevice } = useConnActions();
  const devices = useDevices();
  const curDevice = devices.list.find((d) => d.id === devices.current);
  const openSwitcher = () => showDeviceSwitcher({
    list: devices.list,
    current: devices.current,
    onPick: (id) => { navigation.closeDrawer(); switchDevice(id); },
    onManage: go(() => navigation.navigate('Main', { screen: 'Settings', params: { screen: 'Devices', initial: false } })),
  });
  const goChat = (sessionId, focusSeq) => go(() => navigation.navigate('Main', {
    screen: 'Chat',
    params: focusSeq == null ? { sessionId } : { sessionId, focusSeq, focusNonce: Date.now() },
  }));

  const renderResult = ({ item: s }) => {
    const selected = s.sessionId === list.selectedSessionId;
    const dot = statusColor(colors, s.status) || colors.ink3;
    const field = s.match?.field;
    return (
      <Pressable
        onPress={() => { Keyboard.dismiss(); goChat(s.sessionId, s.match?.field === 'content' ? s.match.seq : undefined)(); }}
        testID={`search-row-${s.sessionId}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${s.title || '空会话'}，${MATCH_LABEL[field] || ''}命中：${s.match?.snippet || ''}，${relTime(s.lastActiveAt)}`}
        style={({ pressed }) => ({
          minHeight: 56, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10, borderCurve: 'continuous',
          backgroundColor: pressed || selected ? colors.glassPressed : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {field === 'title'
            ? <Highlight text={s.title || '(空会话)'} query={query} style={{ flex: 1, color: colors.inkStrong, fontSize: 15 }} hlStyle={{ color: colors.accent, fontWeight: '600' }} />
            : <Text numberOfLines={1} style={{ flex: 1, color: colors.inkStrong, fontSize: 15 }}>{s.title || '(空会话)'}</Text>}
          <View style={{ width: 7, height: 7, borderRadius: 3.5, marginLeft: 10, backgroundColor: dot }} />
        </View>
        {field && field !== 'title' ? (
          <Highlight
            text={`${MATCH_LABEL[field] || ''} · ${s.match.snippet}`}
            query={query}
            style={{ marginTop: 3, color: colors.ink2, fontSize: 12.5, lineHeight: 17 }}
            hlStyle={{ color: colors.accent, fontWeight: '600' }}
          />
        ) : null}
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ marginTop: 2, color: colors.ink3, fontSize: 11.5 }}>
          {s.cwd ? `${shortPath(s.cwd)} · ` : ''}{relTime(s.lastActiveAt)}
        </Text>
      </Pressable>
    );
  };

  const st = search.state;
  const searchFooter = (st.fullLoading || st.truncated || st.error) ? (
    st.error ? (
      <TouchableOpacity onPress={search.retry} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 }}>
        <Text style={{ color: colors.danger, fontSize: 12.5 }}>{st.error} · 点击重试</Text>
      </TouchableOpacity>
    ) : (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 10 }}>
        {st.fullLoading ? <ActivityIndicator size="small" color={colors.ink2} /> : null}
        <Text style={{ color: colors.ink2, fontSize: 12 }}>{st.fullLoading ? '正在搜索对话正文…' : '历史太多，只搜了最近的部分'}</Text>
      </View>
    )
  ) : null;

  const renderItem = ({ item }) => {
    const { group } = item;
    if (item.type === 'project') {
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
          <Pressable
            onPress={() => list.toggle(group.id)}
            testID={`drawer-project-${group.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${group.title}，${group.sessionCount} 个对话${group.cwd ? `，工作目录 ${group.cwd}` : ''}`}
            accessibilityState={{ expanded: group.expanded }}
            style={({ pressed }) => ({
              flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 10, paddingVertical: 9,
              flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 10,
              backgroundColor: pressed ? colors.glassPressed : 'transparent',
            })}
          >
            <Text numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1, color: colors.inkStrong, fontSize: 15, fontWeight: '600' }}>
              {group.title}
            </Text>
            <Icon name={group.expanded ? 'chevron' : 'chevronRight'} size={14} color={colors.ink2} />
            <View style={{ flex: 1 }} />
            <Text style={{ color: colors.ink2, fontSize: 12, fontVariant: ['tabular-nums'] }}>{group.sessionCount}</Text>
          </Pressable>
          {group.cwd ? (
            <Pressable
              onPress={go(() => navigation.navigate('Main', { screen: 'Home', params: { fromCwd: group.cwd, nonce: Date.now() }, pop: true }))}
              testID={`drawer-project-new-${group.id}`}
              accessibilityRole="button"
              accessibilityLabel={`在 ${group.title} 新建对话`}
              accessibilityHint={`工作目录 ${shortPath(group.cwd)}，已有草稿会保留`}
              style={({ pressed }) => ({
                width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10,
                backgroundColor: pressed ? colors.glassPressed : 'transparent',
              })}
            >
              <Icon name="plus" size={18} color={colors.ink2} />
            </Pressable>
          ) : null}
        </View>
      );
    }
    if (item.type === 'footer') {
      const error = group.error || group.moreError;
      const busy = group.loading || group.loadingMore;
      const label = error ? `${error} · 点击重试` : group.hasMore
        ? `加载更早的对话（${group.sessions.length} / ${group.total}）`
        : group.sessions.length ? '' : '这个项目还没有会话';
      if (busy) return <ActivityIndicator style={{ minHeight: 44, justifyContent: 'center' }} color={colors.ink2} />;
      if (!label) return null;
      if (!error && !group.hasMore) return <Text style={{ paddingVertical: 14, paddingLeft: 34, color: colors.ink2, fontSize: 12 }}>{label}</Text>;
      return (
        <TouchableOpacity
          onPress={() => group.error ? list.retry(group.id) : list.loadMore(group.id)}
          testID={`drawer-project-more-${group.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${group.title}，${label}`}
          style={{ minHeight: 44, justifyContent: 'center', paddingVertical: 10, paddingLeft: 34, paddingRight: 12 }}
        >
          <Text style={{ color: error ? colors.danger : colors.ink2, fontSize: 12.5 }}>{label}</Text>
        </TouchableOpacity>
      );
    }
    const s = item.session;
    const selected = s.sessionId === list.selectedSessionId;
    const workspace = group.cwds.length > 1 && s.cwd ? shortPath(s.cwd) : '';
    const dot = statusColor(colors, s.status) || colors.ink3;
    return (
      <Pressable
        onPress={goChat(s.sessionId)}
        testID={`session-row-${s.sessionId}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${s.title || '空会话'}，${s.cwd || '未归类'}，${STATUS_LABEL[s.status] || '状态未知'}，${relTime(s.lastActiveAt)}`}
        style={({ pressed }) => ({
          minHeight: 52, marginLeft: 24, paddingVertical: 10, paddingHorizontal: 10,
          borderRadius: 10, borderCurve: 'continuous',
          backgroundColor: pressed || selected ? colors.glassPressed : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, color: colors.inkStrong, fontSize: 15, letterSpacing: -0.1 }}>
            {s.title || '(空会话)'}
          </Text>
          <View style={{ width: 7, height: 7, borderRadius: 3.5, marginLeft: 10, backgroundColor: dot }} />
        </View>
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ marginTop: 3, color: colors.ink2, fontSize: 12.5 }}>
          {workspace ? `${workspace} · ` : ''}{relTime(s.lastActiveAt)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      {/* 品牌与液态玻璃刷新按钮 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10 }}>
        <Spark size={20} />
        <Text style={{ marginLeft: 9, color: colors.inkStrong, fontFamily: fonts.serif, fontSize: 19, letterSpacing: -0.3 }}>
          Claude Remote
        </Text>
        <View style={{ flex: 1 }} />
        <GlassSurface interactive variant="pill" style={{ borderRadius: 22 }}>
          <Pressable
            onPress={projects.refresh}
            testID="drawer-refresh"
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
            {list.loading
              ? <ActivityIndicator size="small" color={colors.ink2} />
              : <Icon name="refresh" size={18} color={colors.ink} />}
          </Pressable>
        </GlassSurface>
      </View>

      {/* 搜索：先标题/路径/最近消息，再全文 */}
      <View style={{ marginHorizontal: 16, marginBottom: 8, height: 38, borderRadius: 12, borderCurve: 'continuous', backgroundColor: colors.bg2, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 6 }}>
        <Icon name="search" size={16} color={colors.ink2} />
        <TextInput
          value={query}
          onChangeText={onQuery}
          placeholder="搜索对话"
          placeholderTextColor={colors.ink2}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          testID="drawer-search"
          accessibilityLabel="搜索对话"
          style={{ flex: 1, color: colors.inkStrong, fontSize: 15, paddingVertical: 0 }}
        />
      </View>

      {projects.catalogError && !searching ? (
        <TouchableOpacity onPress={projects.refresh} accessibilityRole="button" accessibilityLabel={`${projects.catalogError}，重试`} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 18 }}>
          <Text style={{ color: colors.danger, fontSize: 13 }}>{projects.catalogError} · 点击重试</Text>
        </TouchableOpacity>
      ) : null}
      {searching ? (
        <FlatList
          data={st.results}
          keyExtractor={(r) => r.sessionId}
          renderItem={renderResult}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 2, paddingBottom: bottomBarOffset + 74, flexGrow: 1 }}
          ListFooterComponent={searchFooter}
          ListEmptyComponent={st.loading ? <ActivityIndicator style={{ padding: 16 }} color={colors.ink2} />
            : st.fullLoading || st.error ? null
              : <Text style={{ padding: 16, color: colors.ink2, fontSize: 13, textAlign: 'center' }}>没有找到相关对话</Text>}
        />
      ) : (
      <FlatList
        data={list.rows}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 2, paddingBottom: bottomBarOffset + 74, flexGrow: 1 }}
        ListEmptyComponent={!projects.catalogLoaded ? (
          projects.catalogError ? null : <ActivityIndicator style={{ padding: 16 }} color={colors.ink2} />
        ) : (
          <Text style={{ padding: 16, color: colors.ink2, fontSize: 13, textAlign: 'center' }}>没有会话</Text>
        )}
      />
      )}

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
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 }}>
        {devices.list.length > 1 ? (
          <GlassSurface interactive variant="pill" style={{ borderRadius: 25 }}>
            <Pressable
              onPress={openSwitcher}
              accessibilityRole="button"
              testID="drawer-switch-device"
              accessibilityLabel="切换设备"
              style={({ pressed }) => ({
                width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center',
                backgroundColor: pressed ? colors.glassPressed : 'transparent',
              })}
            >
              <Icon name="laptop" size={20} color={colors.ink} />
            </Pressable>
          </GlassSurface>
        ) : null}
        <GlassSurface interactive variant="pill" style={{ flexShrink: 1, minWidth: 0, borderRadius: 25 }}>
          <Pressable
            onPress={goSettings}
            onLongPress={devices.list.length ? openSwitcher : undefined}
            accessibilityRole="button"
            testID="drawer-settings"
            accessibilityLabel={curDevice ? `设置，当前设备 ${curDevice.name}` : '设置'}
            style={({ pressed }) => ({
              height: 50,
              borderRadius: 25,
              paddingLeft: 16,
              paddingRight: 18,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              backgroundColor: pressed ? colors.glassPressed : 'transparent',
            })}
          >
            <Icon name="settings" size={19} color={colors.ink} />
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.inkStrong, fontSize: 14, fontWeight: '600' }}>
              {curDevice ? curDevice.name : '设置'}
            </Text>
            <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: connDotColor }} />
          </Pressable>
        </GlassSurface>
        </View>

        <Pressable
          onPress={goNew}
          accessibilityRole="button"
          testID="drawer-new-chat"
          accessibilityLabel="新对话"
          style={({ pressed }) => ({
            height: 50,
            borderRadius: 25,
            borderCurve: 'continuous',
            paddingHorizontal: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            backgroundColor: pressed ? '#242424' : '#000000',
          })}
        >
          <Icon name="plus" size={18} strokeWidth={2.1} color="#FFFFFF" />
          <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
            新对话
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
