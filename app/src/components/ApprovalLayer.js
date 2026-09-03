import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, sessionCache } from '../../../web/core/api.js';
import { toast, useBus } from '../../../web/core/bus.js';
import { truncate } from '../lib/format.js';
import { useTheme } from '../theme.js';

// 移植 web/ui/components/approval.js：
// - bus 'ws:approval' 入队（interactionId 去重）；'ws:approval.resolved' 打戳 + scheduleRemoval
// - scheduleRemoval：ref Map 幂等 500ms 后移除；cancelRemoval 配对
// - 只渲染 items[0]，多余显示「还有 N 个待处理」
// - decide 乐观更新（点击立即打戳；HTTP 后台 POST /decision）；409/404 仅 toast 不回滚；其它失败回滚 + toast
// - 键盘弹出时 KeyboardStickyView 把整层托起，骑在键盘上方
// 渲染顺序（App 根保证）：Approval -> PairConfirm -> Toast，本层 zIndex 50（低于 PairConfirm 100、高于 sheet）。

const RESOLVED_LABEL = { allowed: '已允许', denied: '已拒绝', answered: '已作答', expired: '已超时' };

// 倒计时：每秒 tick；剩 ≤20s 变 warn 色；resolved 后停表；过期显示「已超时」。
function Countdown({ expiresAt, stop }) {
  const { colors, fonts } = useTheme();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stop) return undefined;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [stop]);
  const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const warn = left <= 20;
  const text = left > 0
    ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
    : '已超时';
  return (
    <Text
      style={{
        marginLeft: 'auto',
        fontFamily: fonts.mono,
        fontSize: 12.5,
        color: warn ? colors.danger : colors.ink2,
      }}
    >
      {text}
    </Text>
  );
}

// 输入 JSON 折叠块：折叠 = 摘要（截 80 等宽）；展开 = pretty JSON 等宽横向滚动。
function InputBlock({ value }) {
  const { colors, fonts, radius } = useTheme();
  const [open, setOpen] = useState(false);
  const summary = truncate(JSON.stringify(value ?? {}), 80);
  return (
    <View
      style={{
        marginTop: 8,
        borderWidth: 1,
        borderColor: colors.line,
        borderRadius: radius.xs,
        overflow: 'hidden',
        backgroundColor: colors.bg,
      }}
    >
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        style={{ flexDirection: 'row', alignItems: 'center', padding: 9, gap: 6 }}
      >
        <Text style={{ fontSize: 12, color: colors.ink2 }}>⚒</Text>
        <Text
          numberOfLines={1}
          style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: colors.ink2 }}
        >
          {summary}
        </Text>
        <Text style={{ color: colors.ink3, fontSize: 12 }}>{open ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>
      {open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.line, padding: 9 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text
              selectable
              style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.ink, lineHeight: 18 }}
            >
              {JSON.stringify(value ?? {}, null, 2)}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function ApprovalCard({ item, onDecide }) {
  const { colors, fonts, radius } = useTheme();
  const it = item.interaction;
  const [busy, setBusy] = useState(false);
  const [denyMsg, setDenyMsg] = useState('');
  const [answers, setAnswers] = useState(
    () => new Map((it.questions || []).map((q) => [q.question, { sel: new Set(), free: '' }]))
  );
  const sess = sessionCache.get(it.sessionId);
  const sessLabel = sess?.title ? truncate(sess.title, 24) : it.sessionId.slice(0, 8);

  const decide = async (body) => {
    const status = body.type === 'deny' ? 'denied' : (body.type === 'answer' ? 'answered' : 'allowed');
    setBusy(true);
    onDecide(it.interactionId, 'resolve', status);
    try {
      const data = await api(
        `/api/interactions/${encodeURIComponent(it.interactionId)}/decision`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (data && data.status) onDecide(it.interactionId, 'resolve', data.status);
    } catch (e) {
      if (e.status === 409) toast('该审批已在别处处理', 'info');
      else if (e.status === 404) toast('审批已不存在', 'info');
      else {
        onDecide(it.interactionId, 'rollback');
        if (e.code !== 'unauthorized') toast(`提交失败：${e.code}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const setAns = (q, fn) => setAnswers((old) => {
    const next = new Map(old);
    const cur = next.get(q) || { sel: new Set(), free: '' };
    next.set(q, fn({ sel: new Set(cur.sel), free: cur.free }));
    return next;
  });

  const allAnswered = (it.questions || []).every((q) => {
    const a = answers.get(q.question);
    return a && (a.free.trim() || a.sel.size > 0);
  });

  const submitAnswers = () => {
    const out = {};
    for (const q of it.questions || []) {
      const a = answers.get(q.question);
      out[q.question] = a.free.trim() || [...a.sel].join(', ');
    }
    decide({ type: 'answer', answers: out });
  };

  const disabled = busy || !!item.resolved;

  const btnBase = {
    flex: 1,
    borderRadius: radius.sm,
    paddingVertical: 9,
    alignItems: 'center',
  };

  return (
    <View
      style={{
        width: '100%',
        maxWidth: 480,
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.line,
        borderRadius: radius.island,
        padding: 14,
        paddingTop: 16,
        shadowColor: '#000',
        shadowOpacity: 0.22,
        shadowRadius: 17,
        shadowOffset: { width: 0, height: 10 },
        elevation: 6,
        opacity: item.resolved ? 0.8 : 1,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {item.resolved ? (
        <View
          style={{
            position: 'absolute',
            top: 12,
            right: 14,
            backgroundColor:
              item.resolved === 'allowed'
                ? colors.ok + '22'
                : (item.resolved === 'denied' || item.resolved === 'expired')
                  ? colors.danger + '22'
                  : colors.bg2,
            borderRadius: 7,
            paddingHorizontal: 9,
            paddingVertical: 2,
          }}
        >
          <Text
            style={{
              fontSize: 12,
              fontWeight: '600',
              color:
                item.resolved === 'allowed'
                  ? colors.ok
                  : (item.resolved === 'denied' || item.resolved === 'expired')
                    ? colors.danger
                    : colors.ink2,
            }}
          >
            {RESOLVED_LABEL[item.resolved] || item.resolved}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.inkStrong }}>
          {it.kind === 'question' ? '❓ 提问' : '🔐 审批'}
        </Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.accentDeep }}>
          {it.toolName || ''}
        </Text>
        <Countdown expiresAt={it.expiresAt} stop={!!item.resolved} />
      </View>

      <Text style={{ fontSize: 12, color: colors.ink2, marginTop: 2 }}>
        会话：{sessLabel}
      </Text>

      {it.prompt ? (
        <Text style={{ fontSize: 14, color: colors.inkStrong, marginTop: 8, marginBottom: 4 }}>
          {it.prompt}
        </Text>
      ) : null}

      {it.kind === 'approval' ? (
        <>
          <InputBlock value={it.input} />
          <TextInput
            value={denyMsg}
            onChangeText={setDenyMsg}
            placeholder="拒绝理由（可选）"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
            style={{
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: radius.xs,
              paddingHorizontal: 11,
              paddingVertical: 8,
              fontSize: 13.5,
              color: colors.inkStrong,
              backgroundColor: colors.bg,
              marginTop: 8,
              opacity: disabled ? 0.6 : 1,
            }}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <TouchableOpacity
              onPress={() => decide(denyMsg.trim() ? { type: 'deny', message: denyMsg.trim() } : { type: 'deny' })}
              disabled={disabled}
              activeOpacity={0.85}
              style={{
                ...btnBase,
                borderWidth: 1,
                borderColor: '#e8cfc8',
                backgroundColor: 'transparent',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <Text style={{ color: colors.danger, fontSize: 14.5, fontWeight: '500' }}>拒绝</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => decide({ type: 'allow_once' })}
              disabled={disabled}
              activeOpacity={0.85}
              style={{
                ...btnBase,
                borderWidth: 1,
                borderColor: colors.accent,
                backgroundColor: colors.accent,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 14.5, fontWeight: '500' }}>允许一次</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}

      {it.kind === 'question' ? (
        <>
          {(it.questions || []).map((q) => {
            const a = answers.get(q.question) || { sel: new Set(), free: '' };
            return (
              <View key={q.question} style={{ marginTop: 10 }}>
                {q.header ? (
                  <Text
                    style={{
                      fontSize: 11,
                      backgroundColor: colors.bg2,
                      color: colors.ink2,
                      borderRadius: 6,
                      paddingHorizontal: 7,
                      paddingVertical: 1,
                      alignSelf: 'flex-start',
                    }}
                  >
                    {q.header}
                  </Text>
                ) : null}
                <Text style={{ fontSize: 14, color: colors.inkStrong, marginTop: 4, marginBottom: 8 }}>
                  {q.question}
                  {q.multiSelect ? (
                    <Text style={{ fontSize: 12, color: colors.ink2 }}>（可多选）</Text>
                  ) : null}
                </Text>
                <View style={{ gap: 7 }}>
                  {(q.options || []).map((o) => {
                    const on = a.sel.has(o.label);
                    return (
                      <TouchableOpacity
                        key={o.label}
                        onPress={() => setAns(q.question, (cur) => {
                          if (q.multiSelect) {
                            if (cur.sel.has(o.label)) cur.sel.delete(o.label);
                            else cur.sel.add(o.label);
                          } else {
                            cur.sel = cur.sel.has(o.label) ? new Set() : new Set([o.label]);
                          }
                          return cur;
                        })}
                        disabled={busy}
                        activeOpacity={0.85}
                        style={{
                          borderWidth: 1,
                          borderColor: on ? colors.accent : colors.line,
                          borderRadius: 10,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          backgroundColor: on ? colors.accent + '1F' : colors.bg,
                          opacity: busy ? 0.5 : 1,
                        }}
                      >
                        <Text style={{ fontSize: 13.5, color: colors.inkStrong, fontWeight: '500' }}>
                          {o.label}
                        </Text>
                        {o.description ? (
                          <Text style={{ fontSize: 12, color: colors.ink2, marginTop: 1 }}>
                            {o.description}
                          </Text>
                        ) : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TextInput
                  value={a.free}
                  onChangeText={(v) => setAns(q.question, (cur) => { cur.free = v; return cur; })}
                  placeholder="或自由输入…"
                  placeholderTextColor={colors.ink3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!disabled}
                  style={{
                    borderWidth: 1,
                    borderColor: colors.line,
                    borderRadius: radius.xs,
                    paddingHorizontal: 11,
                    paddingVertical: 8,
                    fontSize: 13.5,
                    color: colors.inkStrong,
                    backgroundColor: colors.bg,
                    marginTop: 8,
                    opacity: disabled ? 0.6 : 1,
                  }}
                />
              </View>
            );
          })}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <TouchableOpacity
              onPress={submitAnswers}
              disabled={disabled || !allAnswered}
              activeOpacity={0.85}
              style={{
                ...btnBase,
                borderWidth: 1,
                borderColor: colors.accent,
                backgroundColor: colors.accent,
                opacity: (disabled || !allAnswered) ? 0.5 : 1,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 14.5, fontWeight: '500' }}>提交回答</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </View>
  );
}

export function ApprovalLayer() {
  const { fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState([]);
  const removalTimers = useRef(new Map());

  const scheduleRemoval = useCallback((id) => {
    if (removalTimers.current.has(id)) return; // 幂等：本地与 WS 双触发不重置计时
    const t = setTimeout(() => {
      removalTimers.current.delete(id);
      setItems((xs) => xs.filter((x) => x.interaction.interactionId !== id));
    }, 500);
    removalTimers.current.set(id, t);
  }, []);

  const cancelRemoval = useCallback((id) => {
    const t = removalTimers.current.get(id);
    if (t) { clearTimeout(t); removalTimers.current.delete(id); }
  }, []);

  useBus('ws:approval', ({ interaction }) => {
    setItems((xs) => (
      xs.some((x) => x.interaction.interactionId === interaction.interactionId)
        ? xs
        : [...xs, { interaction }]
    ));
  }, []);
  useBus('ws:approval.resolved', ({ interactionId, status }) => {
    setItems((xs) => xs.map((x) => (
      x.interaction.interactionId === interactionId ? { ...x, resolved: status } : x
    )));
    scheduleRemoval(interactionId);
  }, []);

  // onDecide 回调：'resolve' 打戳+排程移除；'rollback' 清戳+取消移除；'gone' 直接移除。
  const drop = useCallback((id, why, status) => {
    if (why === 'gone') {
      cancelRemoval(id);
      setItems((xs) => xs.filter((x) => x.interaction.interactionId !== id));
      return;
    }
    if (why === 'rollback') {
      cancelRemoval(id);
      setItems((xs) => xs.map((x) => (
        x.interaction.interactionId === id ? { ...x, resolved: null } : x
      )));
      return;
    }
    setItems((xs) => xs.map((x) => (
      x.interaction.interactionId === id ? { ...x, resolved: status } : x
    )));
    scheduleRemoval(id);
  }, [scheduleRemoval, cancelRemoval]);

  if (items.length === 0) return null;
  const current = items[0];
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        elevation: 50,
      }}
    >
      <KeyboardStickyView offset={{ opened: -12 }}>
        <View
          style={{
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: insets.bottom + 12,
          }}
        >
          {items.length > 1 ? (
            <View
              style={{
                backgroundColor: 'rgba(38,35,29,0.75)',
                borderRadius: 999,
                paddingHorizontal: 12,
                paddingVertical: 3,
              }}
            >
              <Text style={{ fontSize: 12, color: '#fff', fontFamily: fonts.serifCn }}>
                还有 {items.length - 1} 个待处理
              </Text>
            </View>
          ) : null}
          <ApprovalCard key={current.interaction.interactionId} item={current} onDecide={drop} />
        </View>
      </KeyboardStickyView>
    </View>
  );
}
