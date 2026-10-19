import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { api, fetchSessions, pendingSessionMessages, sessionCache } from '../../../web/core/api.js';
import { toast, useBus } from '../../../web/core/bus.js';
import { createConversationState, displayKey } from '../../../web/core/conversation-state.js';
import { PERMISSION_MODES, getSessionMode, setSessionMode } from '../../../web/core/modes.js';
import { ws } from '../../../web/core/ws.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
import { GlassSurface } from '../components/GlassSurface.js';
import { Icon } from '../components/Icon.js';
import { MessageRow } from '../components/MessageRow.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Spark } from '../components/Spark.js';
import { ChatComposer } from '../components/composer/ChatComposer.js';
import { useTheme } from '../theme.js';

// 移植 web/ui/screens/chat.js。列表用 inverted FlatList：
// - 数据倒序（最新在 index 0），maintainVisibleContentPosition 原生实现「贴底跟随 + 翻页不跳」
//   （minIndexForVisible:1 避免锚定到正在追加的最新条目，autoscrollToTopThreshold 即 web 的 stick 语义）
// - 向上翻更早消息 = onEndReached（视觉顶部），追加到数据尾端，无需 web 的 prepend 滚动补偿
// 消息身份、发送状态与流式合并由 web/core/conversation-state.js 统一维护。
export function ChatScreen({ route }) {
  const sessionId = route.params.sessionId;
  const navigation = useNavigation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const stateRef = useRef(null);
  if (!stateRef.current) stateRef.current = createConversationState();
  const [version, setVersion] = useState(0);
  const [meta, setMeta] = useState(sessionCache.get(sessionId) || null);
  const [status, setStatus] = useState(sessionCache.get(sessionId)?.status || null);
  const [hasMore, setHasMore] = useState(false);
  const [firstSeq, setFirstSeq] = useState(null);
  const [initLoading, setInitLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [runActive, setRunActive] = useState(() => sessionCache.get(sessionId)?.status === 'daemon-driving');
  const [mode, setMode] = useState(() => getSessionMode(sessionId));
  const [activeRunId, setActiveRunId] = useState(null);
  const [showJump, setShowJump] = useState(false);
  const activeRunIdRef = useRef(null);
  const listRef = useRef(null);
  const loadingOlder = useRef(false);
  const newIds = useRef(new Set());
  const retryInFlight = useRef(new Set());
  const bumpScheduled = useRef(false);
  // ready=false 时把 live 帧排队，订阅确认后的快照合并完成再按序回放。
  const syncRef = useRef({ ready: false, syncing: false, queue: [], gen: 0, timer: null });

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const bumpOnce = useCallback(() => {
    if (bumpScheduled.current) return;
    bumpScheduled.current = true;
    queueMicrotask(() => {
      bumpScheduled.current = false;
      bump();
    });
  }, [bump]);

  const applyFrame = useCallback((frame) => {
    const st = stateRef.current;
    if (frame.type === 'message') st.upsertOfficial(frame.message);
    else if (frame.type === 'stream') {
      st.applyStream({
        runId: frame.runId, messageId: frame.messageId, blockIndex: frame.blockIndex, text: frame.text,
      });
    } else if (frame.type === 'stream_snapshot') {
      st.applyStreamSnapshot({ runId: frame.runId, blocks: frame.blocks });
    }
  }, []);

  const loadSnapshot = useCallback(async (gen) => {
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`;
    let d = null;
    let error = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        d = await api(path);
        error = null;
        break;
      } catch (e) {
        error = e;
        if (e.code !== 'session_not_found' || attempt === 7) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (gen !== syncRef.current.gen) return false;
    if (!d) {
      // 快照失败只报错，不清本地气泡（乐观消息仍可重试/等回显）。
      setLoadErr(error?.code === 'session_not_found' ? '会话不存在' : `加载失败：${error?.code ?? 'unknown'}`);
      setInitLoading(false);
      return false;
    }
    stateRef.current.applySnapshot({ messages: d.messages, firstSeq: d.firstSeq, hasMore: d.hasMore });
    setFirstSeq(d.firstSeq ?? null);
    setHasMore(!!d.hasMore);
    setLoadErr('');
    if (d.status) setStatus(d.status);
    const runId = d.activeRunId ?? null;
    activeRunIdRef.current = runId;
    setActiveRunId(runId);
    setRunActive(d.status === 'daemon-driving' || runId != null);
    setInitLoading(false);
    bump();
    return true;
  }, [sessionId, bump]);

  const startFetch = useCallback(async (gen) => {
    const sync = syncRef.current;
    if (sync.syncing || gen !== sync.gen) return;
    sync.syncing = true;
    clearTimeout(sync.timer);
    sync.timer = null;
    await loadSnapshot(gen);
    if (gen !== sync.gen) return;
    const queued = sync.queue;
    sync.queue = [];
    for (const frame of queued) applyFrame(frame);
    sync.ready = true;
    sync.syncing = false;
    bump();
  }, [loadSnapshot, applyFrame, bump]);

  const waitForSubscribe = useCallback(() => {
    const sync = syncRef.current;
    clearTimeout(sync.timer);
    sync.ready = false;
    sync.syncing = false;
    sync.queue = [];
    const gen = ++sync.gen;
    sync.timer = setTimeout(() => {
      sync.timer = null;
      if (gen === sync.gen) startFetch(gen);
    }, 3000);
  }, [startFetch]);

  const restartSyncNow = useCallback(() => {
    const sync = syncRef.current;
    clearTimeout(sync.timer);
    sync.timer = null;
    sync.ready = false;
    sync.syncing = false;
    sync.queue = [];
    startFetch(++sync.gen);
  }, [startFetch]);

  const onSubscribed = useCallback(() => {
    const sync = syncRef.current;
    clearTimeout(sync.timer);
    sync.timer = null;
    if (sync.syncing) return;
    startFetch(sync.gen);
  }, [startFetch]);

  // ---- 挂载：重置状态、接管新会话待发文本、订阅并等待快照窗口
  useEffect(() => {
    const st = stateRef.current;
    st.reset();
    newIds.current.clear();
    activeRunIdRef.current = null;
    setActiveRunId(null);
    setFirstSeq(null);
    setHasMore(false);
    setInitLoading(true);
    setLoadErr('');
    setMeta(sessionCache.get(sessionId) || null);
    setStatus(sessionCache.get(sessionId)?.status || null);
    setRunActive(sessionCache.get(sessionId)?.status === 'daemon-driving');

    const initial = pendingSessionMessages.get(sessionId);
    if (initial) {
      pendingSessionMessages.delete(sessionId);
      if (typeof initial === 'string') {
        st.addLocal(initial);
      } else {
        const item = st.addLocal(initial.text, initial.clientMessageId);
        if (initial.status === 'accepted') st.markAccepted(item.clientMessageId, initial.runId);
        else if (initial.status === 'unconfirmed') st.markUnconfirmed(item.clientMessageId);
      }
    }
    bump();

    ws.subscribe(sessionId);
    waitForSubscribe();

    (async () => {
      if (!sessionCache.has(sessionId)) { try { await fetchSessions(200); } catch { /* 列表拿不到就用兜底展示 */ } }
      const s = sessionCache.get(sessionId);
      if (s) { setMeta(s); setStatus((cur) => cur ?? s.status); }
    })();

    return () => {
      ws.unsubscribe(sessionId);
      const sync = syncRef.current;
      clearTimeout(sync.timer);
      sync.timer = null;
      sync.gen += 1;
      sync.ready = false;
      sync.syncing = false;
      sync.queue = [];
    };
  }, [sessionId, bump, waitForSubscribe]);

  // ---- WS：订阅确认前缓存 live 帧，确认后快照 + 顺序回放
  const onFrame = useCallback((frame) => {
    const sync = syncRef.current;
    if (!sync.ready) {
      sync.queue.push(frame);
      if (sync.queue.length > 1000) sync.queue.shift();
      return;
    }
    applyFrame(frame);
    bumpOnce();
  }, [applyFrame, bumpOnce]);

  useBus('ws:subscribed', (e) => {
    if (e.sessionId === sessionId && e.ok !== false) onSubscribed();
  }, [sessionId, onSubscribed]);
  useBus('ws:message', (e) => { if (e.sessionId === sessionId) onFrame(e); }, [sessionId, onFrame]);
  useBus('ws:stream', (e) => { if (e.sessionId === sessionId) onFrame(e); }, [sessionId, onFrame]);
  useBus('ws:stream_snapshot', (e) => { if (e.sessionId === sessionId) onFrame(e); }, [sessionId, onFrame]);
  useBus('ws:status', (e) => { if (e.sessionId === sessionId) setStatus(e.status); }, [sessionId]);

  useBus('ws:run', (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.state === 'started') {
      setRunActive(true);
      activeRunIdRef.current = e.runId ?? null;
      setActiveRunId(e.runId ?? null);
      // 本轮显式指定过模式才随帧带 permissionMode；缺席≠default，不据此降级本地记忆
      if (e.permissionMode && PERMISSION_MODES.includes(e.permissionMode)) {
        setMode(e.permissionMode);
        setSessionMode(sessionId, e.permissionMode);
      }
      return;
    }
    // 迟到的终态帧不得结算新一轮；仅当已跟踪到另一个非空 run 时忽略。
    const runId = e.runId ?? null;
    if (activeRunIdRef.current !== null && activeRunIdRef.current !== runId) return;
    if (runId != null) stateRef.current.clearStream(runId);
    activeRunIdRef.current = null;
    setActiveRunId(null);
    setRunActive(false);
    bump();
    if (e.state === 'error') toast(`运行出错：${e.error || '未知错误'}`, 'error');
  }, [sessionId, bump]);

  // ---- resync：daemon 侧链视图失效，清空后立即快照
  useBus('ws:resync', (e) => {
    if (e.sessionId !== sessionId) return;
    stateRef.current.reset();
    activeRunIdRef.current = null;
    setActiveRunId(null);
    bump();
    restartSyncNow();
  }, [sessionId, bump, restartSyncNow]);

  // ---- 重连：重新走订阅 + 快照（空 store 也要同步），并刷新会话元信息
  useBus('ws-open', () => {
    waitForSubscribe();
    (async () => {
      try {
        await fetchSessions(200);
        const s = sessionCache.get(sessionId);
        if (s) { setMeta(s); setStatus(s.status); }
      } catch { /* 状态刷新失败不阻塞同步 */ }
    })();
  }, [sessionId, waitForSubscribe]);

  // ---- 向上翻页（inverted 列表的视觉顶部 = onEndReached）
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || firstSeq == null) return;
    loadingOlder.current = true;
    const gen = syncRef.current.gen;
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${firstSeq}`);
      if (gen !== syncRef.current.gen) return;
      for (const m of d.messages) stateRef.current.upsertOfficial(m);
      setFirstSeq(d.firstSeq ?? null);
      setHasMore(!!d.hasMore);
      bump();
    } catch (e) {
      toast(`历史加载失败：${e.code}`, 'error');
    } finally { loadingOlder.current = false; }
  }, [sessionId, hasMore, firstSeq, bump]);

  const retryLocal = useCallback(async (target) => {
    const st = stateRef.current;
    const item = typeof target === 'string'
      ? st.pendingLocals().find((l) => l.clientMessageId === target)
      : target;
    if (!item?.clientMessageId || retryInFlight.current.has(item.clientMessageId)) return;
    retryInFlight.current.add(item.clientMessageId);
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text: item.text,
          clientMessageId: item.clientMessageId,
          ...(mode !== 'default' ? { permissionMode: mode } : {}),
        }),
      });
      st.markAccepted(item.clientMessageId, d.runId);
    } catch (e) {
      const statusCode = e.status ?? 0;
      const definite = (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429)
        || e.code === 'not_idle' || e.code === 'connection_changed';
      st.markFailed(item.clientMessageId, { definite });
    } finally {
      retryInFlight.current.delete(item.clientMessageId);
      bump();
    }
  }, [sessionId, mode, bump]);

  // ---- composer 契约：本地气泡先进列表，再按 202/失败回填状态
  const onQueue = useCallback(({ clientMessageId, text }) => {
    const item = stateRef.current.addLocal(text, clientMessageId);
    newIds.current.add(displayKey(item));
    bump();
  }, [bump]);

  const onAccepted = useCallback((clientMessageId, runId) => {
    stateRef.current.markAccepted(clientMessageId, runId);
    bump();
  }, [bump]);

  const onSendFailed = useCallback((clientMessageId, definite) => {
    stateRef.current.markFailed(clientMessageId, { definite });
    bump();
  }, [bump]);

  const onScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    setShowJump((s) => (y > 240 ? true : y < 120 ? false : s));
  }, []);
  const jumpToBottom = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setShowJump(false);
  }, []);

  // inverted 数据：最新在前
  const rows = useMemo(() => stateRef.current.items().reverse(), [version]);
  const hasStream = rows.some((m) => m.key != null);
  const isRunning = runActive || status === 'daemon-driving';
  const showRunning = isRunning && !hasStream;
  const title = meta?.title || sessionId.slice(0, 8);
  const hasGap = stateRef.current.hasGap();

  // 视觉底部（inverted 的 ListHeader）：运行中打字点（有流式文本时让位给正文）
  const listHeader = showRunning ? (
    <View style={{ flexDirection: 'row', marginVertical: 6, gap: 8, alignItems: 'center' }}>
      <View style={{ width: 26, alignItems: 'center' }}><Spark size={16} /></View>
      <Text style={{ color: colors.ink2, fontSize: 18, letterSpacing: 2 }}>···</Text>
    </View>
  ) : null;

  // 视觉顶部（inverted 的 ListFooter）：更早消息入口 / 初始加载 / 错误 / 空态
  const listFooter = (
    <View style={{ paddingVertical: 8 }}>
      {initLoading ? <ActivityIndicator color={colors.ink2} /> : null}
      {loadErr ? <Text style={{ textAlign: 'center', color: colors.danger, fontSize: 13 }}>{loadErr}</Text> : null}
      {!initLoading && !loadErr && rows.length === 0 ? (
        <Text style={{ textAlign: 'center', color: colors.ink3, fontSize: 13 }}>（空会话）</Text>
      ) : null}
      {hasGap ? (
        <Text style={{ textAlign: 'center', color: colors.ink3, fontSize: 12, marginBottom: 4 }}>部分历史未加载</Text>
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
          data={rows}
          inverted
          keyExtractor={(m) => m.key ?? displayKey(m)}
          renderItem={({ item }) => (
            <MessageRow
              m={item}
              animate={newIds.current.has(displayKey(item))}
              onAnimated={() => { newIds.current.delete(displayKey(item)); }}
              onRetry={retryLocal}
            />
          )}
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
        onQueue={onQueue}
        onAccepted={onAccepted}
        onSendFailed={onSendFailed}
        onRetry={retryLocal}
      />
    </View>
  );
}
