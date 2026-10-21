import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { api, fetchSessions, pendingSessionMessages, sessionCache } from '../../../web/core/api.js';
import { toast, useBus } from '../../../web/core/bus.js';
import { PERMISSION_MODES, getSessionMode, setSessionMode } from '../../../web/core/modes.js';
import { ws } from '../../../web/core/ws.js';
import { applyStreamFrame, reconcileDrafts } from '../../../web/core/stream-drafts.js';
import { cmpMsg, msgKey } from '../lib/format.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
import { GlassSurface } from '../components/GlassSurface.js';
import { Icon } from '../components/Icon.js';
import { MessageRow } from '../components/MessageRow.js';
import { MarkdownView } from '../components/markdown/MarkdownView.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Spark } from '../components/Spark.js';
import { ChatComposer } from '../components/composer/ChatComposer.js';
import { useTheme } from '../theme.js';

// 移植 web/ui/screens/chat.js。列表用 inverted FlatList：
// - 数据倒序（最新在 index 0），maintainVisibleContentPosition 原生实现「贴底跟随 + 翻页不跳」
//   （minIndexForVisible:1 避免锚定到正在追加的最新条目，autoscrollToTopThreshold 即 web 的 stick 语义）
// - 向上翻更早消息 = onEndReached（视觉顶部），追加到数据尾端，无需 web 的 prepend 滚动补偿
export function ChatScreen({ route }) {
  const sessionId = route.params.sessionId;
  const navigation = useNavigation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const store = useRef({ map: new Map(), sorted: [] });
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState(sessionCache.get(sessionId) || null);
  const [status, setStatus] = useState(sessionCache.get(sessionId)?.status || null);
  const [hasMore, setHasMore] = useState(false);
  const [firstSeq, setFirstSeq] = useState(null);
  const [initLoading, setInitLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [runActive, setRunActive] = useState(() => sessionCache.get(sessionId)?.status === 'daemon-driving');
  const [pending, setPending] = useState(null); // 已 POST、尚未从 WS 回显的用户消息
  const [mode, setMode] = useState(() => getSessionMode(sessionId));
  const [activeRunId, setActiveRunId] = useState(null);
  const [showJump, setShowJump] = useState(false);
  const listRef = useRef(null);
  const loadingOlder = useRef(false);
  // 流式草稿：daemon 的逐字增量，JSONL 落盘后被正式消息替换
  const [drafts, setDrafts] = useState([]);
  const clearTimer = useRef(null);

  const addMsgs = useCallback((list) => {
    const st = store.current;
    const fresh = [];
    for (const m of list) {
      const k = msgKey(m);
      if (!st.map.has(k)) { st.map.set(k, m); fresh.push(m); }
    }
    if (fresh.length === 0) return false;
    fresh.sort(cmpMsg);
    const sorted = st.sorted;
    // 快路径：fresh 整体 ≥ 当前尾部则直接追加，跳过全量 sort（web 同款）
    const canAppend = sorted.length === 0 || cmpMsg(sorted[sorted.length - 1], fresh[0]) <= 0;
    st.sorted = canAppend ? sorted.concat(fresh) : [...st.map.values()].sort(cmpMsg);
    setVersion((v) => v + 1);
    return true;
  }, []);

  // ---- 初始加载：尾部 100 条 + 会话元信息（新会话落盘竞态重试 8 次）
  useEffect(() => {
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    setDrafts([]);
    setInitLoading(true);
    setLoadErr('');
    const initialText = pendingSessionMessages.get(sessionId);
    if (initialText) {
      setPending(initialText);
      pendingSessionMessages.delete(sessionId);
    }
    ws.subscribe(sessionId);
    (async () => {
      try {
        let d;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
            break;
          } catch (error) {
            if (error.code !== 'session_not_found' || attempt === 7) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        addMsgs(d.messages);
        setFirstSeq(d.firstSeq);
        setHasMore(d.hasMore);
      } catch (e) {
        setLoadErr(e.code === 'session_not_found' ? '会话不存在' : `加载失败：${e.code}`);
      } finally { setInitLoading(false); }
      if (!sessionCache.has(sessionId)) { try { await fetchSessions(200); } catch { /* 列表拿不到就用兜底展示 */ } }
      const s = sessionCache.get(sessionId);
      if (s) { setMeta(s); setStatus((st) => st ?? s.status); }
    })();
    return () => ws.unsubscribe(sessionId);
  }, [sessionId, addMsgs]);

  // ---- WS 事件：同 tick 多条 message 微任务合并（web 同款）
  const pendingBatch = useRef(null);
  useBus('ws:message', (e) => {
    if (e.sessionId !== sessionId) return;
    const m = e.message;
    if (m.role === 'user' && m.kind === 'text') {
      setPending((p) => (p && m.text?.trim() === p.trim() ? null : p));
    }
    if (m.role === 'assistant' && m.kind === 'text') setDrafts((d) => reconcileDrafts(d, m));
    if (!pendingBatch.current) {
      pendingBatch.current = [];
      queueMicrotask(() => {
        const batch = pendingBatch.current;
        pendingBatch.current = null;
        if (batch && batch.length) addMsgs(batch);
      });
    }
    pendingBatch.current.push(m);
  }, [sessionId, addMsgs]);
  useBus('ws:stream', (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.clear) {
      // run 结束：落盘的消息通常紧跟着到，留一点时间让它先替换，再清残留
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setDrafts([]), 1500);
      return;
    }
    clearTimeout(clearTimer.current);
    setDrafts((d) => applyStreamFrame(d, e));
  }, [sessionId]);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  useBus('ws:status', (e) => { if (e.sessionId === sessionId) setStatus(e.status); }, [sessionId]);
  useBus('ws:run', (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.state === 'started') {
      setRunActive(true);
      setActiveRunId(e.runId || null);
      // 本轮显式指定过模式才随帧带 permissionMode；缺席≠default，不据此降级本地记忆
      if (e.permissionMode && PERMISSION_MODES.includes(e.permissionMode)) {
        setMode(e.permissionMode);
        setSessionMode(sessionId, e.permissionMode);
      }
    } else {
      setRunActive(false);
      setActiveRunId(null);
      setPending(null);
      if (e.state === 'error') toast(`运行出错：${e.error || '未知错误'}`, 'error');
    }
  }, [sessionId]);
  // ---- resync：daemon 侧链视图失效，清空全量重拉
  useBus('ws:resync', async (e) => {
    if (e.sessionId !== sessionId) return;
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      addMsgs(d.messages);
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
    } catch { /* 拉取失败：等下次 ws-open 补缺口或用户翻页 */ }
  }, [sessionId, addMsgs]);
  // ---- 重连补缺口：拉尾部，无重叠则向前翻直到接上（最多 3 页）
  useBus('ws-open', async () => {
    const st = store.current;
    if (st.map.size === 0) return;
    try {
      let d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      let overlap = d.messages.some((m) => st.map.has(msgKey(m)));
      const pages = [d.messages];
      let guard = 0;
      let cursor = d.firstSeq;
      while (!overlap && d.hasMore && guard++ < 3) {
        d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${cursor}`);
        overlap = d.messages.some((m) => st.map.has(msgKey(m)));
        pages.push(d.messages);
        cursor = d.firstSeq;
      }
      addMsgs(pages.flat());
    } catch { /* 断线补拉失败，等下次重连 */ }
    try {
      await fetchSessions(200);
      const s = sessionCache.get(sessionId);
      if (s) { setMeta(s); setStatus(s.status); }
    } catch { /* 状态刷新失败不阻塞 */ }
  }, [sessionId, addMsgs]);

  // ---- 向上翻页（inverted 列表的视觉顶部 = onEndReached）
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || firstSeq == null) return;
    loadingOlder.current = true;
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${firstSeq}`);
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
      addMsgs(d.messages);
    } catch (e) {
      toast(`历史加载失败：${e.code}`, 'error');
    } finally { loadingOlder.current = false; }
  }, [sessionId, hasMore, firstSeq, addMsgs]);

  const onScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    setShowJump((s) => (y > 240 ? true : y < 120 ? false : s));
  }, []);
  const jumpToBottom = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setShowJump(false);
  }, []);

  // inverted 数据：最新在前
  const msgsDesc = useMemo(() => [...store.current.sorted].reverse(), [version]);

  const isRunning = runActive || status === 'daemon-driving';
  const title = meta?.title || sessionId.slice(0, 8);

  // 视觉底部（inverted 的 ListHeader）：pending 气泡 + 运行中打字点
  const listHeader = (
    <View>
      {pending ? (
        <View style={{ flexDirection: 'row', marginVertical: 6, gap: 8, opacity: 0.65 }}>
          <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bubble, alignItems: 'center', justifyContent: 'center', marginTop: 2 }}>
            <Text style={{ fontSize: 11, color: colors.ink }}>我</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ backgroundColor: colors.bubble, borderRadius: 18, borderTopLeftRadius: 8, paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'flex-start' }}>
              <Text style={{ color: colors.inkStrong, fontSize: 15, lineHeight: 22 }}>{pending}</Text>
            </View>
            <Text style={{ color: colors.ink3, fontSize: 11, marginTop: 2 }}>发送中…</Text>
          </View>
        </View>
      ) : null}
      {drafts.map((d) => (
        <View key={d.key} style={{ marginTop: 8, marginBottom: 20 }}>
          <MarkdownView text={d.text} />
        </View>
      ))}
      {isRunning && !drafts.some((d) => !d.done) ? (
        <View style={{ flexDirection: 'row', marginVertical: 6, gap: 8, alignItems: 'center' }}>
          <View style={{ width: 26, alignItems: 'center' }}><Spark size={16} /></View>
          <Text style={{ color: colors.ink2, fontSize: 18, letterSpacing: 2 }}>···</Text>
        </View>
      ) : null}
    </View>
  );

  // 视觉顶部（inverted 的 ListFooter）：更早消息入口 / 初始加载 / 错误 / 空态
  const listFooter = (
    <View style={{ paddingVertical: 8 }}>
      {initLoading ? <ActivityIndicator color={colors.ink2} /> : null}
      {loadErr ? <Text style={{ textAlign: 'center', color: colors.danger, fontSize: 13 }}>{loadErr}</Text> : null}
      {!initLoading && !loadErr && msgsDesc.length === 0 ? (
        <Text style={{ textAlign: 'center', color: colors.ink3, fontSize: 13 }}>（空会话）</Text>
      ) : null}
      {hasMore ? (
        <TouchableOpacity onPress={loadOlder} style={{ padding: 8 }}>
          <Text style={{ textAlign: 'center', color: colors.ink2, fontSize: 13 }}>↑ 加载更早消息</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
      <ConversationHeader
        title={title}
        newChat
        onNewChat={() => navigation.popTo('Home', { fromCwd: meta?.cwd || sessionCache.get(sessionId)?.cwd || '', nonce: Date.now() })}
        details={`${meta?.cwd || ''}\n${sessionId}`}
        mode={mode}
        onModeChange={(m) => { setMode(m); setSessionMode(sessionId, m); }}
        showModeSelector
        subtitle={<View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <StatusBadge status={status} />
          {mode === 'bypassPermissions' ? <Text style={{ color: colors.danger, fontSize: 11 }}>Bypass</Text> : null}
        </View>}
      />

      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={msgsDesc}
          inverted
          keyExtractor={(m) => msgKey(m)}
          renderItem={({ item }) => <MessageRow m={item} />}
          maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 100 }}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.6}
          onScroll={onScroll}
          scrollEventThrottle={32}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 16 }}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
        />
        {showJump ? (
          <GlassSurface
            interactive
            variant="pill"
            style={{
              position: 'absolute',
              right: 16,
              bottom: 14,
              borderRadius: 22,
            }}
          >
            <Pressable
              onPress={jumpToBottom}
              accessibilityRole="button"
              accessibilityLabel="跳到底部"
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? colors.glassPressed : 'transparent',
              })}
            >
              <Icon name="arrowDown" size={18} color={colors.ink} />
            </Pressable>
          </GlassSurface>
        ) : null}
      </View>

      <ChatComposer
        sessionId={sessionId}
        status={status}
        isRunning={isRunning}
        activeRunId={activeRunId}
        mode={mode}
        onModeChange={(m) => { setMode(m); setSessionMode(sessionId, m); }}
        onStatusConflict={(s) => setStatus(s)}
        onSent={(text) => setPending(text)}
        onStopped={() => { setRunActive(false); setActiveRunId(null); setStatus('idle'); }}
      />
    </View>
  );
}
