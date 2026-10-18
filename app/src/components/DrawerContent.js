import { useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBus } from '../../../web/core/bus.js';
import { ws } from '../../../web/core/ws.js';
import { useTheme } from '../theme.js';
import { GlassSurface } from './GlassSurface.js';
import { Icon } from './Icon.js';
import { ProjectPicker } from './ProjectPicker.js';
import { Spark } from './Spark.js';
import { cwdTail, relTime, statusColor } from '../lib/format.js';
import { useProjects, useSessionList } from '../lib/projects-context.js';
import { filterCount, filterLabel } from '../lib/projects.js';

// 侧栏抽屉：顶部品牌 + 液态玻璃刷新按钮，项目筛选 + 分页会话列表，底部悬浮液态玻璃操作栏（左侧设置与连接状态 + 右侧新对话胶囊按钮）。
export function DrawerContent({ navigation }) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const list = useSessionList();
  const pickerRef = useRef(null);
  const [wsPhase, setWsPhase] = useState(ws.state.phase);
  useBus('ws-state', (s) => setWsPhase(s.phase), []);

  const sorted = list.sessions;
  const { catalog, catalogLoaded, projectId } = projects;
  const scopeLabel = filterLabel(catalog, projectId);
  const scopeCount = catalogLoaded ? filterCount(catalog, projectId) : list.total;

  const connDotColor = wsPhase === 'open' ? colors.ok : wsPhase === 'connecting' ? colors.warn : colors.danger;
  const bottomBarOffset = Math.max(insets.bottom, 14);

  const go = (fn) => () => { fn(); navigation.closeDrawer(); };
  const goNew = go(() => { projects.prepareNewChat(); navigation.navigate('Main', { screen: 'Home', pop: true }); });
  const goSettings = go(() => navigation.navigate('Main', { screen: 'Settings' }));
  const goChat = (sessionId) => go(() => navigation.navigate('Main', { screen: 'Chat', params: { sessionId } }));

  const renderItem = ({ item: s }) => {
    const dot = statusColor(colors, s.status) || colors.ink3;
    return (
      <Pressable
        onPress={goChat(s.sessionId)}
        testID={`session-row-${s.sessionId}`}
        accessibilityRole="button"
        accessibilityLabel={`${s.title || '空会话'}，${s.cwd ? cwdTail(s.cwd) : '未归类'}，${relTime(s.lastActiveAt)}`}
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
          {s.cwd ? cwdTail(s.cwd) : '未归类'} · {relTime(s.lastActiveAt)}
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

      {/* 项目筛选：只影响浏览，不中断运行、不屏蔽全局审批 */}
      <View style={{ paddingHorizontal: 8, paddingBottom: 4 }}>
        <Pressable
          onPress={() => pickerRef.current?.present()}
          testID="drawer-project-filter"
          accessibilityRole="button"
          accessibilityLabel={`浏览项目：${scopeLabel}，${scopeCount} 个对话`}
          accessibilityHint="切换要浏览的项目"
          style={({ pressed }) => ({
            minHeight: 44,
            paddingHorizontal: 10,
            borderRadius: 14,
            borderCurve: 'continuous',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: pressed ? colors.glassPressed : 'transparent',
          })}
        >
          <Icon name="folder" size={16} color={colors.ink2} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink2, fontSize: 13, fontWeight: '600' }}>
            {scopeLabel}
          </Text>
          <Icon name="chevron" size={14} color={colors.ink3} />
          <View style={{ flex: 1 }} />
          {scopeCount > 0 ? (
            <Text style={{ color: colors.ink3, fontFamily: fonts.mono, fontSize: 11.5 }}>
              {scopeCount}
            </Text>
          ) : null}
        </Pressable>
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
        onEndReached={() => { if (list.hasMore && !list.moreError) list.loadMore(); }}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          list.error ? (
            <TouchableOpacity onPress={list.reload} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', padding: 16 }}>
              <Text style={{ color: colors.danger, fontSize: 13, textAlign: 'center' }}>
                {list.error} · 点击重试
              </Text>
            </TouchableOpacity>
          ) : list.loading ? null : (
            <Text style={{ padding: 16, color: colors.ink3, fontSize: 13, textAlign: 'center' }}>
              {projectId === null ? '没有会话' : '这个项目还没有会话'}
            </Text>
          )
        }
        ListFooterComponent={
          !list.hasMore || sorted.length === 0 ? null : list.loadingMore ? (
            <ActivityIndicator style={{ padding: 12 }} color={colors.ink2} />
          ) : (
            <TouchableOpacity
              onPress={list.loadMore}
              testID="drawer-load-more"
              accessibilityRole="button"
              style={{ minHeight: 44, justifyContent: 'center', padding: 12 }}
            >
              <Text style={{ color: list.moreError ? colors.danger : colors.ink3, fontSize: 12.5, textAlign: 'center' }}>
                {list.moreError ? `${list.moreError} · 点击重试` : `加载更早的对话（${sorted.length} / ${list.total}）`}
              </Text>
            </TouchableOpacity>
          )
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
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <GlassSurface interactive variant="pill" style={{ flexShrink: 1, minWidth: 0, borderRadius: 25 }}>
          <Pressable
            onPress={goSettings}
            accessibilityRole="button"
            testID="drawer-settings"
            accessibilityLabel="设置"
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
            <Text style={{ color: colors.inkStrong, fontSize: 14, fontWeight: '600' }}>
              设置
            </Text>
            <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: connDotColor }} />
          </Pressable>
        </GlassSurface>

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
      <ProjectPicker
        sheetRef={pickerRef}
        variant="filter"
        catalog={catalog}
        value={projectId}
        onPick={projects.selectProject}
        loaded={catalogLoaded}
        error={projects.catalogError}
        onRetry={projects.refresh}
      />
    </View>
  );
}
