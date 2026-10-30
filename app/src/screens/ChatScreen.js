import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TouchableOpacity, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import { useNavigation } from '@react-navigation/native';
import { api, fetchSessions, pendingSessionMessages, sessionCache } from '../../../web/core/api.js';
import { toast, useBus } from '../../../web/core/bus.js';
import { PERMISSION_MODES, getSessionMode, setSessionMode } from '../../../web/core/modes.js';
import { ws } from '../../../web/core/ws.js';
import { applyStreamFrame, reconcileCurrentTurnDrafts, removeDraftKeys } from '../../../web/core/stream-drafts.js';
import { findFocusIndex, loadUntilSeq } from '../../../web/core/search.js';
import { cmpMsg, msgKey } from '../lib/format.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
import { GlassSurface } from '../components/GlassSurface.js';
import { Icon } from '../components/Icon.js';
import { MessageRow } from '../components/MessageRow.js';
import { MarkdownView } from '../components/markdown/MarkdownView.js';
import { TypingDots } from '../components/TypingDots.js';
import { ChatComposer } from '../components/composer/ChatComposer.js';
import { useTheme } from '../theme.js';
import { haptics } from '../lib/haptics.js';

// 移植 web/ui/screens/chat.js。列表用 inverted FlatList：
// - 数据倒序（最新在 index 0）。贴底时倒置列表天然「新内容把旧内容往上顶」；
//   maintainVisibleContentPosition 只在翻看历史时开启，保证新消息进来阅读位置不动。
//   贴底时不能开：iOS 会先补偿 offset 再动画滚回底部，发消息、出打字点时整屏滑一下（实测录屏）
// - 键盘：列表用 KeyboardChatScrollView 加 contentInset、输入框和跳底按钮用 KeyboardStickyView 平移，
//   键盘动画期间不改布局（逐帧改 padding 会整页重排，收键盘时掉帧）。贴底 offset 因此是 -inset 而非 0
// - 向上翻更早消息 = onEndReached（视觉顶部），追加到数据尾端，无需 web 的 prepend 滚动补偿
const MVCP_READING = { minIndexForVisible: 0 };
const isEcho = (m, text) => m.role === 'user' && m.kind === 'text' && m.text?.trim() === text.trim();

const pendingText = (p) => p.match ?? p.text;

// 刚发出的气泡从输入框方向弹起；回显后由同尺寸的正式消息原位替换
function PendingBubble({ text, sending }) {
  const reduceMotion = useReducedMotion();
  const p = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (!reduceMotion) p.value = withSpring(1, { damping: 16, stiffness: 180, mass: 0.8 });
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 1.6),
    transform: [{ translateY: (1 - p.value) * 36 }, { scale: 0.9 + 0.1 * p.value }],
  }));
  return (
    <Animated.View style={[{ transformOrigin: 'right bottom' }, style]}>
      <MessageRow m={{ role: 'user', text }} sending={sending} />
    </Animated.View>
  );
}

export function ChatScreen({ route }) {
  const sessionId = route.params.sessionId;
  const focusSeq = route.params.focusSeq;
  const focusNonce = route.params.focusNonce;
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
  // 已点发送、尚未从 WS 回显的用户消息：{ id, text, match? }。
  // text 是气泡显示的输入内容；match 是 POST 实际发出的文本（带附件说明时与 text 不同），用于认回显
  const [pending, setPending] = useState(null);
  const lastUserEcho = useRef(null); // 最近一条用户消息回显：回显可能先于 POST 响应到达
  const [mode, setMode] = useState(() => getSessionMode(sessionId));
  const [activeRunId, setActiveRunId] = useState(null);
  const activeRunIdRef = useRef(null);
  const [showJump, setShowJump] = useState(false);
  const [readingHistory, setReadingHistory] = useState(false);
  const listRef = useRef(null);
  const loadingOlder = useRef(false);
  // 分页游标的同步镜像：搜索定位在异步流程里要读最新值
  const pageRef = useRef({ firstSeq: null, hasMore: false });
  pageRef.current = { firstSeq, hasMore };
  const [highlightKey, setHighlightKey] = useState(null);
  const [focusTarget, setFocusTarget] = useState(null); // { key, nonce }
  const highlightTimer = useRef(null);
  // 流式草稿：daemon 的逐字增量，JSONL 落盘后被正式消息替换
  const [drafts, setDrafts] = useState([]);
  const draftsRef = useRef(drafts);
  const clearTimer = useRef(null);
  const runFloorSeq = useRef(0);
  const loadGeneration = useRef(0);
  const stateRevision = useRef(0);
  const recoveryGeneration = useRef(0);
  const completedRuns = useRef(new Set());
  const liveKeys = useRef(new Set());
  const applyRunState = useCallback((nextStatus, runId = null) => {
    if (nextStatus !== 'daemon-driving' || runId) stateRevision.current += 1;
    activeRunIdRef.current = runId;
    setActiveRunId(runId);
    setRunActive(!!runId || nextStatus === 'daemon-driving');
    setStatus(nextStatus);
  }, []);
  const updateDrafts = useCallback((update) => {
    const next = typeof update === 'function' ? update(draftsRef.current) : update;
    if (next === draftsRef.current) return;
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const addMsgs = useCallback((list) => {
    const st = store.current;
    const fresh = [];
    for (const m of list) {
      const k = msgKey(m);
      if (!st.map.has(k)) { st.map.set(k, m); fresh.push(m); }
    }
    if (fresh.length > 0) {
      fresh.sort(cmpMsg);
      const sorted = st.sorted;
      // 快路径：fresh 整体 ≥ 当前尾部则直接追加，跳过全量 sort（web 同款）
      const canAppend = sorted.length === 0 || cmpMsg(sorted[sorted.length - 1], fresh[0]) <= 0;
      st.sorted = canAppend ? sorted.concat(fresh) : [...st.map.values()].sort(cmpMsg);
      setVersion((v) => v + 1);
    }
    // 首屏、WS、重连、resync、分页都从这里对账；重复补拉也要能消解草稿
    updateDrafts((d) => reconcileCurrentTurnDrafts(d, st.sorted, runFloorSeq.current));
    return fresh.length > 0;
  }, [updateDrafts]);

  // ---- 初始加载：尾部 100 条 + 会话元信息（新会话落盘竞态重试 8 次）
  useEffect(() => {
    const generation = ++loadGeneration.current;
    clearTimeout(clearTimer.current);
    pendingBatch.current = null;
    runFloorSeq.current = 0;
    completedRuns.current.clear();
    applyRunState(sessionCache.get(sessionId)?.status || null);
    liveKeys.current.clear();
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    updateDrafts([]);
    setInitLoading(true);
    setLoadErr('');
    const initialText = pendingSessionMessages.get(sessionId);
    if (initialText) {
      setPending({ id: Date.now(), text: initialText, after: null, sent: true });
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
        if (generation !== loadGeneration.current) return;
        addMsgs(d.messages);
        // 新会话的首条消息可能在订阅前就已落盘（WS 回显错过），以首屏数据为准撤掉"发送中"
        setPending((p) => (p && d.messages.some((m) => isEcho(m, pendingText(p))) ? null : p));
        setFirstSeq(d.firstSeq);
        setHasMore(d.hasMore);
      } catch (e) {
        if (generation === loadGeneration.current) setLoadErr(e.code === 'session_not_found' ? '会话不存在' : `加载失败：${e.code}`);
      } finally {
        if (generation === loadGeneration.current) setInitLoading(false);
      }
      if (generation !== loadGeneration.current) return;
      if (!sessionCache.has(sessionId)) { try { await fetchSessions(200); } catch { /* 列表拿不到就用兜底展示 */ } }
      if (generation !== loadGeneration.current) return;
      const s = sessionCache.get(sessionId);
      if (s) setMeta(s);
    })();
    return () => {
      loadGeneration.current += 1;
      clearTimeout(clearTimer.current);
      ws.unsubscribe(sessionId);
    };
  }, [sessionId, addMsgs, updateDrafts, applyRunState]);

  // ---- WS 事件：同 tick 多条 message 微任务合并（web 同款）
  const pendingBatch = useRef(null);
  useBus('ws:message', (e) => {
    if (e.sessionId !== sessionId) return;
    const m = e.message;
    liveKeys.current.add(msgKey(m));
    if (m.role === 'user' && m.kind === 'text') lastUserEcho.current = m.text?.trim() ?? null;
    setPending((p) => (p && isEcho(m, pendingText(p)) ? null : p));
    const generation = loadGeneration.current;
    if (!pendingBatch.current) {
      pendingBatch.current = [];
      queueMicrotask(() => {
        if (generation !== loadGeneration.current) return;
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
      // 落盘消息通常紧跟着到；计时器只清本轮已有的 key，不能误删下一轮草稿
      const keys = new Set(draftsRef.current.map((d) => d.key));
      clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => {
        updateDrafts((current) => removeDraftKeys(current, keys));
      }, 1500);
      return;
    }
    clearTimeout(clearTimer.current);
    updateDrafts((d) => reconcileCurrentTurnDrafts(applyStreamFrame(d, e), store.current.sorted, runFloorSeq.current));
  }, [sessionId, updateDrafts]);
  useEffect(() => () => clearTimeout(clearTimer.current), []);
  useBus('ws:session-state', (e) => {
    if (e.sessionId !== sessionId) return;
    const previousRunId = activeRunIdRef.current;
    applyRunState(e.status, e.activeRunId || null);
    if (!e.activeRunId || (previousRunId && previousRunId !== e.activeRunId)) {
      clearTimeout(clearTimer.current);
      updateDrafts([]);
      runFloorSeq.current = 0;
    }
  }, [sessionId, updateDrafts, applyRunState]);
  useBus('ws:status', (e) => {
    if (e.sessionId !== sessionId) return;
    applyRunState(e.status, e.status === 'daemon-driving' ? activeRunIdRef.current : null);
  }, [sessionId, applyRunState]);
  useBus('ws:run', (e) => {
    if (e.sessionId !== sessionId) return;
    if (e.state === 'started') {
      applyRunState('daemon-driving', e.runId || null);
      clearTimeout(clearTimer.current);
      updateDrafts([]);
      const sorted = store.current.sorted;
      runFloorSeq.current = (sorted.length ? (sorted[sorted.length - 1].seq || 0) : 0) + 1;
      // 本轮显式指定过模式才随帧带 permissionMode；缺席≠default，不据此降级本地记忆
      if (e.permissionMode && PERMISSION_MODES.includes(e.permissionMode)) {
        setMode(e.permissionMode);
        setSessionMode(sessionId, e.permissionMode);
      }
    } else {
      // 上一轮终态可能迟到：只能结束它自己，不能清掉已开始的新一轮
      if (e.runId && activeRunIdRef.current && e.runId !== activeRunIdRef.current) return;
      if (e.state === 'done' && e.runId && !completedRuns.current.has(e.runId)) {
        completedRuns.current.add(e.runId);
        haptics.success();
      }
      applyRunState('idle');
      setPending(null);
      if (e.state === 'error') toast(`运行出错：${e.error || '未知错误'}`, 'error');
    }
  }, [sessionId, updateDrafts, applyRunState]);
  // ---- resync：daemon 侧链视图失效，清空全量重拉
  useBus('ws:resync', async (e) => {
    if (e.sessionId !== sessionId) return;
    const generation = ++loadGeneration.current;
    clearTimeout(clearTimer.current);
    pendingBatch.current = null;
    runFloorSeq.current = 0;
    store.current = { map: new Map(), sorted: [] };
    setVersion((v) => v + 1);
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      if (generation !== loadGeneration.current) return;
      addMsgs(d.messages);
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
      setInitLoading(false);
      setLoadErr('');
    } catch { /* 拉取失败：等下次 ws-open 补缺口或用户翻页 */ }
  }, [sessionId, addMsgs]);
  useBus('ws-state', (e) => {
    if (e.phase !== 'open') recoveryGeneration.current += 1;
  }, []);
  // ---- 重连补缺口：拉尾部，无重叠则向前翻直到接上（最多 3 页）
  useBus('ws-open', async () => {
    const generation = loadGeneration.current;
    const recovery = ++recoveryGeneration.current;
    const isCurrent = () => generation === loadGeneration.current && recovery === recoveryGeneration.current;
    const st = store.current;
    try {
      let d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`);
      if (!isCurrent()) return;
      let overlap = d.messages.some((m) => st.map.has(msgKey(m)));
      const pages = [d.messages];
      const tail = d;
      let guard = 0;
      let cursor = d.firstSeq;
      while (st.sorted.length && !overlap && d.hasMore && guard++ < 3) {
        d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${cursor}`);
        if (!isCurrent()) return;
        overlap = d.messages.some((m) => st.map.has(msgKey(m)));
        pages.push(d.messages);
        cursor = d.firstSeq;
      }
      addMsgs(pages.flat());
      if (st.sorted.length === 0 || pageRef.current.firstSeq == null) {
        setFirstSeq(d.firstSeq);
        setHasMore(d.hasMore);
      }
      setPending((p) => (p && tail.messages.some((m) => isEcho(m, pendingText(p))) ? null : p));
      setInitLoading(false);
      setLoadErr('');
    } catch { /* 断线补拉失败，等下次重连 */ }
    if (!isCurrent()) return;
    try {
      await fetchSessions(200);
      if (!isCurrent()) return;
      const s = sessionCache.get(sessionId);
      if (s) setMeta(s);
    } catch { /* 元信息刷新失败不阻塞；运行状态由订阅快照恢复 */ }
  }, [sessionId, addMsgs]);

  // ---- 向上翻页（inverted 列表的视觉顶部 = onEndReached）
  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || firstSeq == null) return;
    const generation = loadGeneration.current;
    loadingOlder.current = true;
    try {
      const d = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=100&beforeSeq=${firstSeq}`);
      if (generation !== loadGeneration.current) return;
      setFirstSeq(d.firstSeq);
      setHasMore(d.hasMore);
      addMsgs(d.messages);
    } catch (e) {
      toast(`历史加载失败：${e.code}`, 'error');
    } finally { loadingOlder.current = false; }
  }, [sessionId, hasMore, firstSeq, addMsgs]);

  // ---- 搜索结果定位：翻页直到覆盖命中的 seq，再滚过去高亮
  useEffect(() => {
    if (focusSeq == null || initLoading || loadErr) return;
    let cancelled = false;
    const generation = loadGeneration.current;
    (async () => {
      loadingOlder.current = true;
      try {
        const r = await loadUntilSeq(
          (before) => api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&beforeSeq=${before}`),
          pageRef.current,
          focusSeq,
        );
        if (cancelled || generation !== loadGeneration.current) return;
        if (r.messages.length) {
          setFirstSeq(r.firstSeq);
          setHasMore(r.hasMore);
          addMsgs(r.messages);
        }
        const sorted = store.current.sorted;
        const i = findFocusIndex(sorted, focusSeq);
        if (i < 0) { toast('没找到这条消息，可能已被改写', 'info'); return; }
        setFocusTarget({ key: msgKey(sorted[i]), nonce: focusNonce });
      } catch (e) {
        if (!cancelled && generation === loadGeneration.current) toast(`定位失败：${e.code}`, 'error');
      } finally { loadingOlder.current = false; }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, focusSeq, focusNonce, initLoading, loadErr]);

  const lastKey = () => {
    const s = store.current.sorted;
    return s.length ? msgKey(s[s.length - 1]) : null;
  };
  const onSending = useCallback((text) => {
    lastUserEcho.current = null;
    if (text) setPending({ id: Date.now(), text, after: lastKey(), sent: false });
    return { generation: loadGeneration.current, revision: stateRevision.current };
  }, []);
  const onSent = useCallback((text, runId, context) => {
    if (!context || context.generation !== loadGeneration.current) return;
    if (context.revision === stateRevision.current && runId) applyRunState('daemon-driving', runId);
    else if (activeRunIdRef.current !== runId) return;
    if (lastUserEcho.current === text.trim()) { setPending(null); return; }
    setPending((p) => (p ? { ...p, text, match: text, sent: true } : { id: Date.now(), text, match: text, after: lastKey(), sent: true }));
  }, [applyRunState]);

  const kbOffset = Math.max(insets.bottom, 8); // 与 ChatComposer 底部安全区间距一致
  const insetTop = useRef(0);
  const onContentInsetChange = useCallback((i) => { insetTop.current = i.top; }, []);
  const renderScroll = useCallback((props) => (
    <KeyboardChatScrollView {...props} inverted offset={kbOffset} onContentInsetChange={onContentInsetChange} />
  ), [kbOffset, onContentInsetChange]);
  const onScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y + insetTop.current;
    setShowJump((s) => (y > 240 ? true : y < 120 ? false : s));
    setReadingHistory((r) => (y > 160 ? true : y < 80 ? false : r));
  }, []);
  const jumpToBottom = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: -insetTop.current, animated: true });
    setShowJump(false);
  }, []);

  // inverted 数据：最新在前
  const msgsDesc = useMemo(() => [...store.current.sorted].reverse(), [version]);

  // msgsDesc 更新后再滚动（inverted：index 0 = 最新）
  useEffect(() => {
    if (!focusTarget) return;
    const index = msgsDesc.findIndex((m) => msgKey(m) === focusTarget.key);
    if (index < 0) return;
    const t = setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      setHighlightKey(focusTarget.key);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightKey(null), 2500);
    }, 60);
    setFocusTarget(null);
    return () => clearTimeout(t);
  }, [focusTarget, msgsDesc]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  const onScrollToIndexFailed = useCallback((info) => {
    // 目标行尚未测量：先按平均行高粗滚过去，渲染出来后再精确对齐
    listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 }), 120);
  }, []);

  // 回显可能经 WS、首屏、重连补拉任一路径进列表，各自 setPending 会和加消息错开一帧（两个气泡并存）；
  // 渲染时直接判断：pending 之后的新消息里已有回显就不再画待发送气泡
  const showPending = useMemo(() => {
    if (!pending) return false;
    for (const m of msgsDesc) {
      if (msgKey(m) === pending.after) return true;
      if (isEcho(m, pendingText(pending))) return false;
    }
    return true;
  }, [pending, msgsDesc]);

  const isRunning = runActive || status === 'daemon-driving';
  const title = meta?.title || sessionId.slice(0, 8);

  // 视觉底部（inverted 的 ListHeader）：pending 气泡 + 运行中打字点。
  // 转圈只表示 POST 未返回；发出前不出打字点，保证「转圈 → 发出 → Claude 开始回复」的顺序
  const listHeader = (
    <View>
      {showPending ? <PendingBubble key={pending.id} text={pending.text} sending={!pending.sent} /> : null}
      {drafts.map((d) => (
        <View key={d.key} style={{ marginTop: 8, marginBottom: 20 }}>
          <MarkdownView text={d.text} />
        </View>
      ))}
      {isRunning && !(showPending && !pending.sent) && !drafts.some((d) => !d.done) ? (
        <TypingDots style={{ marginVertical: 8 }} />
      ) : null}
    </View>
  );

  // 视觉顶部（inverted 的 ListFooter）：更早消息入口 / 初始加载 / 错误 / 空态
  const listFooter = (
    <View style={{ paddingVertical: 8 }}>
      {initLoading && !showPending ? <ActivityIndicator color={colors.ink2} /> : null}
      {loadErr ? <Text style={{ textAlign: 'center', color: colors.danger, fontSize: 13 }}>{loadErr}</Text> : null}
      {!initLoading && !loadErr && !showPending && msgsDesc.length === 0 ? (
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
        subtitle={mode === 'bypassPermissions' ? <Text style={{ color: colors.danger, fontSize: 11, marginTop: 4 }}>Bypass</Text> : null}
      />

      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          data={msgsDesc}
          inverted
          renderScrollComponent={renderScroll}
          keyExtractor={(m) => msgKey(m)}
          renderItem={({ item }) => {
            const k = msgKey(item);
            const row = <MessageRow m={item} live={liveKeys.current.has(k)} />;
            return k === highlightKey
              ? <View style={{ backgroundColor: colors.glassTintAccent, borderRadius: 12, marginHorizontal: -8, paddingHorizontal: 8 }}>{row}</View>
              : row;
          }}
          extraData={highlightKey}
          onScrollToIndexFailed={onScrollToIndexFailed}
          maintainVisibleContentPosition={readingHistory ? MVCP_READING : undefined}
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
          <KeyboardStickyView offset={{ opened: kbOffset }} style={{ position: 'absolute', right: 16, bottom: 14 }}>
          <GlassSurface interactive variant="pill" style={{ borderRadius: 22 }}>
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
          </KeyboardStickyView>
        ) : null}
      </View>

      <ChatComposer
        sessionId={sessionId}
        status={status}
        isRunning={isRunning}
        activeRunId={activeRunId}
        mode={mode}
        onModeChange={(m) => { setMode(m); setSessionMode(sessionId, m); }}
        onStatusConflict={(s) => applyRunState(s, s === 'daemon-driving' ? activeRunIdRef.current : null)}
        onSending={onSending}
        onSent={onSent}
        onSendFailed={() => setPending(null)}
        onRunMismatch={(runId, s) => applyRunState(s, runId)}
        onStopped={() => applyRunState('idle')}
      />
    </View>
  );
}
