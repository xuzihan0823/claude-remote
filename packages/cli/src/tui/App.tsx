// cr 全屏控制台（Ink）。
//
// 视图：
//   main      会话列表 + 搜索框 + 选中会话预览
//   session   单会话实时视图：WS 增量消息 + 底部输入框（经 daemon 发送，手机端同步可见）
//   approvals 待审批列表：y 允许 / n 拒绝；AskUserQuestion 用数字键选项
//   pair      配对二维码
//   logs      daemon 日志尾部（每秒刷新）
//   settings  daemon 配置（写 .env 后自动重启 daemon；改地址/端口/token 时 TUI 重新加载以换用新连接）
//   help      快捷键说明
//
// 会话接管：空闲会话按 o → 退出 TUI，在当前终端 claude --resume；claude 退出后回到 TUI。
// 正在被手机/daemon 驱动的会话不允许 o（两边会抢同一个会话），只能实时旁观并经 daemon 回复。

import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ApprovalCard, RenderMessage, SearchMatch, ServerFrame, SessionSummary } from "../api.js";
import { ApiError } from "../api.js";
import type { DaemonSnapshot } from "../daemon-control.js";
import {
  describeMessage,
  fit,
  formatUptime,
  projectName,
  relativeTime,
  STATUS_ICON,
  STATUS_LABEL,
  summarizeInput,
} from "../format.js";
import { snapshotRelayLine } from "../relay.js";
import type { ConfigValue, TuiDeps } from "./deps.js";

export type View = "main" | "session" | "approvals" | "pair" | "logs" | "help" | "settings";
export type TuiExit =
  | { kind: "quit" }
  | { kind: "resume"; session: SessionSummary }
  /** 连接参数（地址/端口/token）变了：main 重新加载 CliEnv 后再开 TUI，落在 then 视图。 */
  | { kind: "reload"; then: View };
type Row = SessionSummary & { match?: SearchMatch };

const STATUS_COLOR: Record<SessionSummary["status"], string> = {
  idle: "gray",
  "terminal-driving": "yellow",
  "daemon-driving": "green",
};

function useTerminalSize(): { columns: number; rows: number } {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const read = (): { columns: number; rows: number } => ({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = (): void => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "会话正忙（手机或终端正在用），等它空闲再发";
    if (error.status === 401) return "token 不匹配";
    return `daemon 返回 ${error.status} ${error.code}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 只保留适合预览的消息（文本、工具调用），按 seq+blockIndex 去重。 */
function mergeMessages(current: RenderMessage[], incoming: RenderMessage[]): RenderMessage[] {
  const key = (m: RenderMessage): string => `${m.seq}:${m.blockIndex}`;
  const map = new Map(current.map((m) => [key(m), m]));
  for (const m of incoming) map.set(key(m), m);
  return [...map.values()].sort((a, b) => a.seq - b.seq || a.blockIndex - b.blockIndex).slice(-200);
}

function messageLines(messages: RenderMessage[], width: number, maxLines: number): Array<{ who: string; text: string; color: string }> {
  const lines: Array<{ who: string; text: string; color: string }> = [];
  for (const m of messages) {
    if (m.kind === "thinking" || m.kind === "meta") continue;
    const { who, text } = describeMessage(m);
    const color = m.role === "user" && m.kind === "text" ? "cyan" : m.kind === "text" ? "white" : "gray";
    if (m.kind === "text") {
      const chunks = text.trim().split(/\n+/).filter((l) => l.trim() !== "");
      chunks.forEach((chunk, i) => lines.push({ who: i === 0 ? who : "", text: fit(chunk, width - 8, false), color }));
    } else {
      lines.push({ who, text: fit(text, width - 10, false), color });
    }
  }
  return lines.slice(-maxLines);
}

export function App({
  deps,
  onExit,
  initialView = "main",
}: {
  deps: TuiDeps;
  onExit: (exit: TuiExit) => void;
  initialView?: View;
}): React.JSX.Element {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [snap, setSnap] = useState<DaemonSnapshot | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState<ApprovalCard[]>([]);
  const [view, setView] = useState<View>(initialView);
  const [focus, setFocus] = useState<"list" | "search">("list");
  const [query, setQuery] = useState("");
  const [fullText, setFullText] = useState(false);
  const [results, setResults] = useState<Row[] | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState<RenderMessage[]>([]);
  const [detail, setDetail] = useState<RenderMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [approvalIdx, setApprovalIdx] = useState(0);
  const [pairData, setPairData] = useState<{ qr: string; bases: string[] } | undefined>(undefined);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [detailSession, setDetailSession] = useState<SessionSummary | undefined>(undefined);
  const [config, setConfig] = useState<ConfigValue[]>(() => (initialView === "settings" ? deps.config.read() : []));
  const [configIdx, setConfigIdx] = useState(0);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [confirmToken, setConfirmToken] = useState(false);

  const streamRef = useRef<ReturnType<NonNullable<TuiDeps["connect"]>> | undefined>(undefined);
  const watchRef = useRef<{ preview?: string | undefined; detail?: string | undefined }>({});

  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((current) => (current === text ? undefined : current)), 4000);
  }, []);

  // -- 数据：快照轮询 -------------------------------------------------------
  const refresh = useCallback(async () => {
    const next = await deps.snapshot();
    setSnap(next);
    setPending(next.pending);
  }, [deps]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // -- 数据：WS 事件 --------------------------------------------------------
  useEffect(() => {
    if (deps.connect === undefined) return;
    const onFrame = (frame: ServerFrame): void => {
      switch (frame.type) {
        case "status":
          setSnap((s) =>
            s === undefined
              ? s
              : { ...s, sessions: s.sessions.map((x) => (x.sessionId === frame.sessionId ? { ...x, status: frame.status } : x)) },
          );
          setResults((r) => r?.map((x) => (x.sessionId === frame.sessionId ? { ...x, status: frame.status } : x)));
          setDetailSession((d) => (d?.sessionId === frame.sessionId ? { ...d, status: frame.status } : d));
          break;
        case "approval":
          setPending((p) => (p.some((c) => c.interactionId === frame.interaction.interactionId) ? p : [...p, frame.interaction]));
          process.stdout.write("\x07"); // 终端响铃提醒
          break;
        case "approval.resolved":
          setPending((p) => p.filter((c) => c.interactionId !== frame.interactionId));
          break;
        case "message":
          if (watchRef.current.preview === frame.sessionId) setPreview((m) => mergeMessages(m, [frame.message]));
          if (watchRef.current.detail === frame.sessionId) setDetail((m) => mergeMessages(m, [frame.message]));
          break;
        case "resync":
          if (watchRef.current.detail === frame.sessionId && deps.api !== undefined) {
            void deps.api.messages(frame.sessionId, 80).then((r) => setDetail(r.messages)).catch(() => {});
          }
          break;
        case "run":
          if (frame.state === "error" && watchRef.current.detail === frame.sessionId) flash(`运行出错：${frame.error ?? "未知错误"}`);
          break;
      }
    };
    const stream = deps.connect({ onFrame, onConnection: setConnected });
    streamRef.current = stream;
    return () => {
      stream.close();
      streamRef.current = undefined;
    };
  }, [deps, flash]);

  // -- 搜索（防抖） -----------------------------------------------------------
  useEffect(() => {
    const q = query.trim();
    if (q === "" || deps.api === undefined) {
      setResults(undefined);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      deps.api
        ?.search(q, fullText, 100)
        .then((r) => {
          if (cancelled) return;
          setResults(r.results);
          setSelected(0);
          if (r.truncated) flash("历史太大，全文检索提前停止，结果可能不完整");
        })
        .catch((error: unknown) => !cancelled && flash(errorText(error)))
        .finally(() => !cancelled && setSearching(false));
    }, fullText ? 350 : 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, fullText, deps.api, flash]);

  const list: Row[] = useMemo(() => results ?? snap?.sessions ?? [], [results, snap]);
  const current = list[Math.min(selected, Math.max(0, list.length - 1))];

  // -- 预览：选中会话最近消息 ------------------------------------------------
  useEffect(() => {
    if (current === undefined || deps.api === undefined || view !== "main") return;
    const id = current.sessionId;
    const timer = setTimeout(() => {
      const prev = watchRef.current.preview;
      if (prev !== undefined && prev !== watchRef.current.detail) streamRef.current?.unsubscribe(prev);
      watchRef.current.preview = id;
      streamRef.current?.subscribe(id);
      deps.api
        ?.messages(id, 30)
        .then((r) => watchRef.current.preview === id && setPreview(r.messages))
        .catch(() => setPreview([]));
    }, 120);
    return () => clearTimeout(timer);
  }, [current?.sessionId, deps.api, view]);

  useEffect(() => {
    if (initialView === "pair") void deps.pair().then(setPairData);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // -- 日志视图刷新 -----------------------------------------------------------
  useEffect(() => {
    if (view !== "logs") return;
    const load = (): void => setLogLines(deps.readLogTail(500));
    load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [view, deps]);

  const openDetail = useCallback(
    (session: SessionSummary) => {
      if (deps.api === undefined) return;
      watchRef.current.detail = session.sessionId;
      streamRef.current?.subscribe(session.sessionId);
      setDetailSession(session);
      setDetail([]);
      setDraft("");
      setView("session");
      deps.api
        .messages(session.sessionId, 80)
        .then((r) => setDetail(r.messages))
        .catch((error: unknown) => flash(errorText(error)));
    },
    [deps.api, flash],
  );

  const closeDetail = useCallback(() => {
    const id = watchRef.current.detail;
    watchRef.current.detail = undefined;
    if (id !== undefined && id !== watchRef.current.preview) streamRef.current?.unsubscribe(id);
    setView("main");
  }, []);

  const quit = useCallback(
    (result: TuiExit) => {
      onExit(result);
      exit();
    },
    [exit, onExit],
  );

  const tryResume = useCallback(
    (session: SessionSummary | undefined) => {
      if (session === undefined) return;
      if (session.status !== "idle") {
        flash(`会话正${STATUS_LABEL[session.status]}，现在接管会和另一端抢。按 Enter 实时旁观`);
        return;
      }
      quit({ kind: "resume", session });
    },
    [flash, quit],
  );

  const runControl = useCallback(
    async (label: string, action: () => Promise<unknown>, done: string) => {
      if (!deps.control.available) {
        flash("这台机器上不能控制 daemon");
        return;
      }
      setBusy(label);
      try {
        const ok = await action();
        flash(ok === false ? `${done}，但 20 秒内没响应，按 l 看日志` : done);
      } catch (error) {
        flash(errorText(error));
      } finally {
        setBusy(undefined);
        void refresh();
      }
    },
    [deps.control, flash, refresh],
  );

  const decide = useCallback(
    async (card: ApprovalCard, decision: Parameters<NonNullable<TuiDeps["api"]>["decide"]>[1]) => {
      if (deps.api === undefined) return;
      try {
        const r = await deps.api.decide(card.interactionId, decision);
        setPending((p) => p.filter((c) => c.interactionId !== card.interactionId));
        flash(r.status === "allowed" ? `已允许 ${card.toolName}` : r.status === "denied" ? `已拒绝 ${card.toolName}` : "已回答");
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setPending((p) => p.filter((c) => c.interactionId !== card.interactionId));
          flash("已在别处处理过了");
        } else flash(errorText(error));
      }
    },
    [deps.api, flash],
  );

  const daemonUp = snap?.reachable === true && !snap.unauthorized;

  /** 写完 .env 之后让配置生效：能控制 launchd 就重启；连接参数变了再整体重载 TUI。 */
  const applyConfig = useCallback(
    async (opts: { restart: boolean; reload: boolean; then: View; saved: string }) => {
      setConfig(deps.config.read());
      if (!opts.restart) {
        flash(opts.saved);
        return;
      }
      if (!deps.control.available || !daemonUp) {
        flash(`${opts.saved}，daemon 下次启动时生效`);
        return;
      }
      setBusy("重启中");
      try {
        await deps.control.restart();
      } catch (error) {
        flash(errorText(error));
        setBusy(undefined);
        return;
      }
      setBusy(undefined);
      if (opts.reload) quit({ kind: "reload", then: opts.then });
      else {
        flash(`${opts.saved}，daemon 已重启`);
        void refresh();
      }
    },
    [deps, daemonUp, flash, quit, refresh],
  );

  const saveField = useCallback(
    (entry: ConfigValue, raw: string) => {
      try {
        deps.config.set(entry.field, raw);
      } catch (error) {
        flash(errorText(error));
        return false;
      }
      const label = raw.trim() === "" ? `${entry.field.label} 已恢复默认` : `${entry.field.label} 已保存`;
      if (entry.field.hosting === true) {
        // 托管方式变了：退出 TUI，由 main 按新设置切换 launchd / 随 cr 运行后再回来
        quit({ kind: "reload", then: "settings" });
        return true;
      }
      void applyConfig({
        restart: true,
        reload: entry.field.affectsCli === true,
        then: "settings",
        saved: label,
      });
      return true;
    },
    [deps.config, flash, applyConfig, quit],
  );

  // -- 键盘 ---------------------------------------------------------------------
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      quit({ kind: "quit" });
      return;
    }

    if (view === "session") {
      if (key.escape) closeDetail();
      else if (key.ctrl && input === "o") tryResume(detailSession);
      else if (key.ctrl && input === "x" && detailSession !== undefined && deps.api !== undefined) {
        deps.api.abort(detailSession.sessionId).then(() => flash("已请求中止当前轮次"), (e: unknown) => flash(errorText(e)));
      }
      return; // 其余按键交给输入框
    }

    if (view === "approvals") {
      const card = pending[Math.min(approvalIdx, pending.length - 1)];
      if (key.escape || input === "q") setView("main");
      else if (key.upArrow || input === "k") setApprovalIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j") setApprovalIdx((i) => Math.min(pending.length - 1, i + 1));
      else if (card !== undefined && card.kind === "approval" && input === "y") void decide(card, { type: "allow_once" });
      else if (card !== undefined && input === "n") void decide(card, { type: "deny", message: "在终端拒绝" });
      else if (card !== undefined && card.kind === "question" && /^[1-9]$/.test(input)) {
        const q = card.questions?.[0];
        const option = q?.options[Number(input) - 1];
        if (q !== undefined && option !== undefined) void decide(card, { type: "answer", answers: { [q.question]: option.label } });
      }
      return;
    }

    if (view === "settings") {
      if (editing !== undefined) {
        if (key.escape) setEditing(undefined);
        return; // 交给输入框
      }
      const tokenRow = configIdx === config.length;
      if (confirmToken) {
        setConfirmToken(false);
        if (input === "y") {
          deps.config.rotateToken();
          void applyConfig({ restart: true, reload: true, then: "pair", saved: "已生成新 token" });
        } else flash("已取消");
        return;
      }
      if (key.escape || input === "q") setView("main");
      else if (key.upArrow || input === "k") setConfigIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j") setConfigIdx((i) => Math.min(config.length, i + 1));
      else if (key.return) {
        const entry = config[configIdx];
        if (tokenRow) setConfirmToken(true);
        else if (entry?.field.hosting === true) saveField(entry, (entry.value ?? entry.field.fallback) === "on" ? "off" : "on"); // 开关：Enter 直接切换
        else setEditing(entry?.value ?? "");
      } else if (input === "d" && !tokenRow) {
        const entry = config[configIdx];
        if (entry !== undefined && entry.value !== undefined) saveField(entry, "");
      }
      return;
    }

    if (view === "pair" || view === "logs" || view === "help") {
      if (key.escape || input === "q") setView("main");
      return;
    }

    // main
    if (focus === "search") {
      if (key.escape) {
        if (query === "") setFocus("list");
        else setQuery("");
      } else if (key.return || key.downArrow) setFocus("list");
      else if (key.tab) setFullText((f) => !f);
      return; // 文字输入交给 TextInput
    }

    if (input === "q") quit({ kind: "quit" });
    else if (input === "/" ) setFocus("search");
    else if (key.tab) setFullText((f) => !f);
    else if (key.escape && query !== "") setQuery("");
    else if (key.upArrow || input === "k") {
      if (selected === 0) setFocus("search");
      else setSelected((i) => Math.max(0, i - 1));
    } else if (key.downArrow || input === "j") setSelected((i) => Math.min(list.length - 1, i + 1));
    else if (key.pageDown) setSelected((i) => Math.min(list.length - 1, i + 10));
    else if (key.pageUp) setSelected((i) => Math.max(0, i - 10));
    else if (key.return && current !== undefined) openDetail(current);
    else if (input === "o") tryResume(current);
    else if (input === "a") {
      setApprovalIdx(0);
      setView("approvals");
    } else if (input === "p") {
      setView("pair");
      void deps.pair().then(setPairData);
    } else if (input === "l") setView("logs");
    else if (input === "?") setView("help");
    else if (input === "c") {
      setConfig(deps.config.read());
      setEditing(undefined);
      setConfirmToken(false);
      setView("settings");
    }
    else if (input === "r") void runControl("重启中", deps.control.restart, "daemon 已重启");
    else if (input === "s") {
      if (daemonUp) void runControl("停止中", deps.control.down, "daemon 已停止（取消开机自启，按 s 再启动）");
      else void runControl("启动中", deps.control.up, "daemon 已启动");
    } else if (input === "g") void refresh().then(() => flash("已刷新"));
  });

  // -- 渲染 ---------------------------------------------------------------------
  const width = Math.max(60, columns);
  const inner = width - 4;

  const header = (
    <Box borderStyle="round" borderColor={daemonUp ? "green" : "red"} flexDirection="column" paddingX={1} width={width}>
      <Box justifyContent="space-between">
        <Text bold>Claude Remote</Text>
        <Text>
          {snap === undefined ? (
            <Text color="gray">连接中…</Text>
          ) : daemonUp ? (
            <Text color="green">
              ● 运行中{snap.uptimeMs === undefined ? "" : `  ${formatUptime(snap.uptimeMs)}`}
              {connected ? "" : "  (实时通道断开)"}
            </Text>
          ) : snap.unauthorized ? (
            <Text color="red">● token 不匹配</Text>
          ) : (
            <Text color="red">● 未运行 · 按 s 启动</Text>
          )}
          {busy === undefined ? "" : <Text color="yellow">  {busy}…</Text>}
        </Text>
      </Box>
      <Text color="gray">{fit(deps.baseUrl + (snap?.claudeCliVersion ? `  ·  claude ${snap.claudeCliVersion}` : ""), inner)}</Text>
    </Box>
  );

  const approvalBanner =
    pending.length > 0 && view !== "approvals" ? (
      <Box paddingX={1}>
        <Text color="black" backgroundColor="yellow">
          {` ⚠ ${pending.length} 个待审批：${fit(`${pending[0]?.toolName ?? ""} ${summarizeInput(pending[0]?.input ?? {})}`, inner - 22, false)}  按 a 处理 `}
        </Text>
      </Box>
    ) : null;

  const toastLine = toast === undefined ? null : (
    <Box paddingX={1}>
      <Text color="cyan">{fit(toast, inner, false)}</Text>
    </Box>
  );

  if (view === "help") {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Text bold>会话列表</Text>
          <Text>  ↑↓ / j k   选择          Enter  实时查看并回复（经 daemon，手机同步）</Text>
          <Text>  o          在本终端 claude --resume 接管（仅空闲会话）</Text>
          <Text>  /          搜索          Tab    切换 标题/路径 ⇄ 全文</Text>
          <Text bold>{"\n"}daemon</Text>
          <Text>  s 启动/停止   r 重启   l 日志   p 配对二维码   c 设置   g 刷新</Text>
          <Text bold>{"\n"}审批</Text>
          <Text>  a 打开待审批   y 允许   n 拒绝   1-9 选择问题选项</Text>
          <Text bold>{"\n"}会话视图</Text>
          <Text>  Enter 发送   Esc 返回   Ctrl+O 本地接管   Ctrl+X 中止当前轮次</Text>
          <Text color="gray">{"\n"}Esc 返回 · Ctrl+C 退出</Text>
        </Box>
      </Box>
    );
  }

  if (view === "pair") {
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box flexDirection="column" paddingX={2}>
          {pairData === undefined ? (
            <Text color="gray">生成中…（没有 token 时先运行 cr setup）</Text>
          ) : (
            <>
              <Text>{pairData.qr}</Text>
              <Text>iPhone 相机扫码，点「在 Claude Remote 中打开」即可配对</Text>
              {pairData.bases.map((b) => (
                <Text key={b} color="gray">  {b}</Text>
              ))}
              <Text color="yellow">二维码就是凭据，别截图外传</Text>
            </>
          )}
          <Text color="gray">Esc 返回</Text>
        </Box>
      </Box>
    );
  }

  if (view === "settings") {
    const entry = config[configIdx];
    const tokenRow = configIdx === config.length;
    return (
      <Box flexDirection="column" width={width}>
        {header}
        {toastLine}
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          {config.map((c, i) => {
            const sel = i === configIdx;
            const isEditing = sel && editing !== undefined;
            return (
              <Box key={c.field.key}>
                <Text inverse={sel && !isEditing}>
                  {sel ? "❯ " : "  "}
                  {fit(c.field.label, 20)}
                </Text>
                {isEditing ? (
                  <TextInput
                    value={editing}
                    onChange={setEditing}
                    placeholder={`留空恢复默认（${c.field.fallback}）`}
                    onSubmit={(text) => {
                      if (saveField(c, text)) setEditing(undefined);
                    }}
                  />
                ) : c.value === undefined ? (
                  <Text color="gray">{fit(`${c.field.fallback}  默认`, inner - 24, false)}</Text>
                ) : (
                  <Text color="cyan">{fit(c.value, inner - 24, false)}</Text>
                )}
              </Box>
            );
          })}
          <Text inverse={tokenRow}>
            {tokenRow ? "❯ " : "  "}
            {fit("重置 token", 20)}
          </Text>
          <Box marginTop={1}>
            <Text color="gray">{fit("  relay", 22)}</Text>
            <Text color="gray">{fit(snapshotRelayLine(snap, { configured: false, enabled: false, relays: [] }), inner - 24, false)}</Text>
          </Box>
        </Box>
        <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} width={width}>
          <Text color={confirmToken ? "yellow" : "gray"}>
            {confirmToken
              ? "旧 token 立即失效，已配对的手机都要重新扫码。按 y 确认，其他键取消"
              : tokenRow
                ? "生成新的访问凭据。二维码泄露或换手机时用"
                : fit(entry?.field.hint ?? "", inner - 2, false)}
          </Text>
        </Box>
        <Text color="gray">
          {editing !== undefined ? " Enter 保存（自动重启 daemon）· Esc 取消" : " ↑↓ 选择 · Enter 修改 · d 恢复默认 · Esc 返回"}
        </Text>
      </Box>
    );
  }

  if (view === "logs") {
    const visible = logLines.slice(-Math.max(5, rows - 6));
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Box flexDirection="column" paddingX={1}>
          {visible.length === 0 ? <Text color="gray">（日志为空）</Text> : visible.map((line, i) => (
            <Text key={i} {...(/error|fail|错误/i.test(line) ? { color: "red" } : {})}>{fit(line, inner, false)}</Text>
          ))}
        </Box>
        <Text color="gray"> 每秒刷新 · Esc 返回</Text>
      </Box>
    );
  }

  if (view === "approvals") {
    const card = pending[Math.min(approvalIdx, pending.length - 1)];
    return (
      <Box flexDirection="column" width={width}>
        {header}
        {toastLine}
        {pending.length === 0 ? (
          <Box paddingX={2} paddingY={1}><Text color="gray">没有待审批的操作</Text></Box>
        ) : (
          <Box flexDirection="column" paddingX={1}>
            {pending.map((c, i) => {
              const session = snap?.sessions.find((s) => s.sessionId === c.sessionId);
              return (
                <Text key={c.interactionId} inverse={i === approvalIdx}>
                  {fit(`${i === approvalIdx ? "❯" : " "} ${c.toolName}  ${projectName(session?.cwd ?? "")}  ${summarizeInput(c.input)}`, inner)}
                </Text>
              );
            })}
            {card === undefined ? null : (
              <Box borderStyle="single" flexDirection="column" paddingX={1} marginTop={1}>
                <Text bold>{card.prompt}</Text>
                {card.kind === "question" ? (
                  card.questions?.[0]?.options.map((o, i) => (
                    <Text key={o.label}>
                      <Text color="yellow">{i + 1}</Text> {o.label}
                      {o.description ? <Text color="gray">  {o.description}</Text> : null}
                    </Text>
                  ))
                ) : (
                  <Text color="gray">{JSON.stringify(card.input, null, 2).split("\n").slice(0, Math.max(3, rows - 16)).join("\n")}</Text>
                )}
                <Text color="gray">{Math.max(0, Math.ceil((card.expiresAt - Date.now()) / 60_000))} 分钟内不处理会自动拒绝</Text>
              </Box>
            )}
          </Box>
        )}
        <Text color="gray">
          {card?.kind === "question" ? " 数字键选择 · n 拒绝" : " y 允许一次 · n 拒绝"} · ↑↓ 切换 · Esc 返回
        </Text>
      </Box>
    );
  }

  if (view === "session" && detailSession !== undefined) {
    // 顶栏 4 + 标题 1 + 输入框 3 + 底栏 1，再减掉可选的审批横幅/提示行；超出终端高度会把顶栏挤出屏幕
    const msgHeight = Math.max(3, rows - 10 - (approvalBanner ? 1 : 0) - (toastLine ? 1 : 0));
    const lines = messageLines(detail, inner, msgHeight);
    const canSend = detailSession.status === "idle";
    return (
      <Box flexDirection="column" width={width}>
        {header}
        {approvalBanner}
        <Box paddingX={1}>
          <Text color={STATUS_COLOR[detailSession.status]}>{STATUS_ICON[detailSession.status]} </Text>
          <Text bold>{fit(`${projectName(detailSession.cwd)} · ${detailSession.title}`, inner - 14, false)}</Text>
          <Text color="gray">  {STATUS_LABEL[detailSession.status]}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} height={msgHeight}>
          {lines.map((l, i) => (
            <Text key={i} color={l.color}>
              <Text color="gray">{fit(l.who, 7)}</Text>
              {l.text}
            </Text>
          ))}
        </Box>
        {toastLine}
        <Box borderStyle="round" borderColor={canSend ? "cyan" : "gray"} paddingX={1} width={width}>
          <Text color="cyan">❯ </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            placeholder={canSend ? "回复（经 daemon 发送，手机端同步看到）" : "会话运行中，等它空闲后才能发送"}
            onSubmit={(text) => {
              const value = text.trim();
              if (value === "" || deps.api === undefined) return;
              deps.api.send(detailSession.sessionId, value).then(
                () => setDraft(""),
                (error: unknown) => flash(errorText(error)),
              );
            }}
          />
        </Box>
        <Text color="gray"> Enter 发送 · Esc 返回 · Ctrl+O 本地接管 · Ctrl+X 中止</Text>
      </Box>
    );
  }

  // main
  const previewHeight = Math.min(8, Math.max(3, Math.floor(rows / 4)));
  const fixed = 4 + 3 + previewHeight + 2 + 2 + (approvalBanner ? 1 : 0) + (toastLine ? 1 : 0);
  const listHeight = Math.max(3, rows - fixed);
  const start = Math.max(0, Math.min(selected - Math.floor(listHeight / 2), list.length - listHeight));
  const visible = list.slice(start, start + listHeight);
  const titleWidth = Math.max(10, inner - 2 - 2 - 16 - 2 - 8 - 2 - 10 - 2);
  const previewLines = messageLines(preview, inner, previewHeight);

  return (
    <Box flexDirection="column" width={width}>
      {header}
      {approvalBanner}
      <Box borderStyle="single" borderColor={focus === "search" ? "cyan" : "gray"} paddingX={1} width={width}>
        <Text>🔍 </Text>
        <Box flexGrow={1}>
          <TextInput value={query} onChange={setQuery} focus={focus === "search"} placeholder="按 / 搜索会话" showCursor={focus === "search"} />
        </Box>
        <Text color="gray">{searching ? "搜索中… " : ""}[Tab] </Text>
        <Text color={fullText ? "gray" : "cyan"}>标题/路径</Text>
        <Text color="gray"> ⇄ </Text>
        <Text color={fullText ? "cyan" : "gray"}>全文</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} height={listHeight}>
        {snap === undefined ? (
          <Text color="gray">加载中…</Text>
        ) : !daemonUp && results === undefined ? (
          <Text color="gray">{snap.error ?? "daemon 未运行"}</Text>
        ) : list.length === 0 ? (
          <Text color="gray">{query.trim() === "" ? "还没有会话" : fullText ? "没有匹配的会话" : "标题和路径里没找到，按 Tab 搜全文"}</Text>
        ) : (
          visible.map((s, i) => {
            const idx = start + i;
            const isSel = idx === selected && focus === "list";
            const sub = s.match !== undefined && (s.match.field === "content" || s.match.field === "preview");
            return (
              <Text key={s.sessionId} inverse={isSel}>
                {isSel ? "❯ " : "  "}
                <Text color={STATUS_COLOR[s.status]}>{STATUS_ICON[s.status]} </Text>
                {fit(projectName(s.cwd), 16)}  {fit(sub ? `${s.title} ↳ ${s.match?.snippet ?? ""}` : s.title, titleWidth)}  <Text color={s.status === "idle" ? "gray" : STATUS_COLOR[s.status]}>{fit(STATUS_LABEL[s.status], 8)}</Text>  <Text color="gray">{fit(relativeTime(s.lastActiveAt), 10)}</Text>
              </Text>
            );
          })
        )}
      </Box>
      <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1} width={width} height={previewHeight + 3}>
        <Text color="gray">{current === undefined ? "预览" : fit(`预览 · ${projectName(current.cwd)} · ${current.sessionId.slice(0, 8)}`, inner - 2)}</Text>
        {previewLines.map((l, i) => (
          <Text key={i} color={l.color}>
            <Text color="gray">{fit(l.who, 7)}</Text>
            {l.text}
          </Text>
        ))}
      </Box>
      {toastLine}
      <Text color="gray"> ↑↓ 选择 ⏎ 查看/回复 o 本地接管 a 审批 p 配对 l 日志 r 重启 s 启停 c 设置 ? 帮助 q 退出</Text>
    </Box>
  );
}
