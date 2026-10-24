import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { createNavigationContainerRef, DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createDrawerNavigator } from '@react-navigation/drawer';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { markSplashHidden, SPLASH_FADE_MS } from './lib/intro.js';

import {
  baseUrl, BASE_KEY, clearToken, connErrMsg, connHost, loadBases, normalizeBase,
  pendingSessionMessages, probeBase, probeBases, saveBases, saveConn, sessionCache, token, TOKEN_KEY,
} from '../../web/core/api.js';
import { api } from '../../web/core/api.js';
import { bus, toast, useBus } from '../../web/core/bus.js';
import { candidateBases, currentDeviceId, displayName, getDevice, loadDevices, updateDevice, upsertDevice } from '../../web/core/devices.js';
import { applyAppearance } from './lib/prefs.js';
import { ws } from '../../web/core/ws.js';
import { parseDeepLink } from './lib/deep-link.js';
import { ConnActions } from './lib/conn-context.js';
import { ProjectsProvider } from './lib/projects-context.js';
import { useTheme } from './theme.js';
import { ConnectScreen } from './screens/ConnectScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { ChatScreen } from './screens/ChatScreen.js';
import { SettingsNavigator } from './screens/settings/SettingsNavigator.js';
import { DrawerContent } from './components/DrawerContent.js';
import { PairConfirm } from './components/PairConfirm.js';
import { ApprovalLayer } from './components/ApprovalLayer.js';
import { ToastLayer } from './components/Toast.js';

// 原生启动屏只是纯底色（图片是全透明占位，底色与 theme 的 bg 一致），保持到连接校验结束，
// 再淡出交给首页 / 登录页的芒星绽放动画（动画按 introDelay 等启动屏淡出后再开始）。
SplashScreen.preventAutoHideAsync().catch(() => { /* noop */ });
try { SplashScreen.setOptions({ duration: SPLASH_FADE_MS, fade: true }); } catch { /* 旧版本无此 API */ }
const SPLASH_MAX_MS = 2500;
applyAppearance(); // 设置里选的浅色 / 深色要在首帧前生效
loadDevices(); // 旧版单连接数据迁移成设备列表 // 网络慢时最多等这么久，之后照常显示「连接中」

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef();
const Drawer = createDrawerNavigator();

function MainStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        getId={({ params }) => params?.sessionId}
      />
      <Stack.Screen name="Settings" component={SettingsNavigator} options={{ presentation: 'modal' }} />
    </Stack.Navigator>
  );
}

export default function App() {
  const { dark, colors } = useTheme();
  const [auth, setAuth] = useState(token ? 'checking' : 'need');
  const [authErr, setAuthErr] = useState('');
  const authRef = useRef(auth);
  authRef.current = auth;
  // baseUrl/token 是模块变量，不会触发渲染；仅在连接成功后更新，用作导航与项目上下文的挂载 key
  const [conn, setConn] = useState(() => ({ key: `${baseUrl}\n${token}`, base: baseUrl }));
  const connKeyRef = useRef(conn.key);
  const commitConn = useCallback(() => {
    const key = `${baseUrl}\n${token}`;
    if (connKeyRef.current === key) return;
    connKeyRef.current = key;
    sessionCache.clear();
    pendingSessionMessages.clear();
    setConn({ key, base: baseUrl });
  }, []);

  useEffect(() => {
    const hide = () => { markSplashHidden(); SplashScreen.hideAsync().catch(() => { /* noop */ }); };
    if (auth !== 'checking') { hide(); return undefined; }
    const timer = setTimeout(hide, SPLASH_MAX_MS);
    return () => clearTimeout(timer);
  }, [auth]);

  useBus('unauthorized', () => {
    ws.stop();
    clearToken();
    localStorage.removeItem(TOKEN_KEY);
    setAuth('need');
    setAuthErr('token 已失效，请重新输入');
  }, []);
  useBus('logout', () => {
    ws.stop();
    saveConn('', '');
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(BASE_KEY);
    setAuth('need');
    setAuthErr('');
  }, []);

  // opts.beforeCommit：探测成功后、切到首页前调用（登录页借此播放「已连接」衔接动画）
  // 连接成功后记下这台 Mac（设备列表），再异步取主机名 / 版本补全显示信息
  const rememberDevice = useCallback((bases, base, tok) => {
    const d = upsertDevice({ bases, base, token: tok });
    bus.emit('devices');
    api('/api/health').then((h) => {
      updateDevice(d.id, { autoName: h?.hostname ? displayName(h.hostname, base) : undefined, info: { version: h?.version, claudeCliVersion: h?.claudeCliVersion } });
      bus.emit('devices');
    }).catch(() => { /* 显示信息缺失不影响使用 */ });
    return d;
  }, []);

  const tryConnect = useCallback(async (base, tok, opts) => {
    setAuth((a) => (a === 'ok' ? 'ok' : 'checking'));
    setAuthErr('');
    const nextBase = normalizeBase(base);
    try {
      await probeBase(nextBase, tok);
      if (opts?.beforeCommit) await opts.beforeCommit();
      saveConn(nextBase, tok);
      rememberDevice([nextBase], nextBase, tok);
      commitConn();
      setAuth('ok');
      ws.stop();
      ws.start();
      return true;
    } catch (e) {
      const msg = connErrMsg(e);
      if (authRef.current !== 'ok') { setAuth('need'); setAuthErr(msg); }
      toast(msg, 'error');
      return false;
    }
  }, [commitConn, rememberDevice]);

  const tryConnectBases = useCallback(async (bases, tok, opts) => {
    setAuth((a) => (a === 'ok' ? 'ok' : 'checking'));
    setAuthErr('');
    try {
      const base = await probeBases(bases, tok);
      if (opts?.beforeCommit) await opts.beforeCommit();
      saveBases(bases);
      saveConn(base, tok);
      rememberDevice(bases, base, tok);
      commitConn();
      setAuth('ok');
      ws.stop();
      ws.start();
      return true;
    } catch (e) {
      const msg = connErrMsg(e);
      if (authRef.current !== 'ok') { setAuth('need'); setAuthErr(msg); }
      toast(msg, 'error');
      return false;
    }
  }, [commitConn, rememberDevice]);

  // 切到某台已配对设备（设置 → 设备）。成功后整个导航按新连接重挂载。
  const switchDevice = useCallback(async (id) => {
    const d = getDevice(id);
    if (!d) return false;
    const ok = await tryConnectBases(candidateBases(d), d.token);
    if (ok) toast(`已切换到 ${getDevice(id)?.name || d.name}`, 'info');
    return ok;
  }, [tryConnectBases]);

  // 启动自动重连：优先多候选探测（扫码配对存的 bases），退回单地址
  useEffect(() => {
    if (!token) return;
    const cur = getDevice(currentDeviceId());
    if (cur && cur.token === token) { tryConnectBases(candidateBases(cur), token); return; }
    const bases = loadBases();
    if (bases.length > 0) tryConnectBases(bases, token);
    else tryConnect(baseUrl, token);
  }, []);

  // RN 后台会挂起 timer，回前台必须主动重连（迁移计划 §4）
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && authRef.current === 'ok') ws.reconnectNow();
    });
    return () => sub.remove();
  }, []);

  // claude-remote:// 深链（冷启动 + 运行中）：
  //   setup    → 配对确认
  //   approval → 打开所属会话并把这条审批顶到最前（推送点击）
  //   session  → 打开会话（运行完成 / 出错推送）
  // 导航类链接要等连上 daemon 且导航容器就绪，先存起来再 flush。
  const [pairReq, setPairReq] = useState(null);
  const [pairBusy, setPairBusy] = useState(false);
  const pendingLinkRef = useRef(null);
  const flushLink = useCallback(() => {
    const link = pendingLinkRef.current;
    if (!link || authRef.current !== 'ok' || !navigationRef.isReady()) return;
    pendingLinkRef.current = null;
    if (link.sessionId) navigationRef.navigate('Main', { screen: 'Chat', params: { sessionId: link.sessionId } });
    if (link.type === 'approval') bus.emit('approval-focus', { interactionId: link.interactionId });
  }, []);
  const handleUrl = useCallback((url) => {
    if (!url || !url.startsWith('claude-remote:')) return;
    const link = parseDeepLink(url);
    if (!link) { toast('无法识别的链接', 'error'); return; }
    if (link.type === 'setup') { setPairReq({ token: link.token, bases: link.bases }); return; }
    pendingLinkRef.current = link;
    flushLink();
  }, [flushLink]);
  useEffect(() => { if (auth === 'ok') flushLink(); }, [auth, flushLink]);
  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    Linking.getInitialURL().then(handleUrl).catch(() => { /* noop */ });
    return () => sub.remove();
  }, [handleUrl]);
  const confirmPair = useCallback(async () => {
    if (!pairReq || pairBusy) return;
    setPairBusy(true);
    const ok = await tryConnectBases(pairReq.bases, pairReq.token);
    setPairBusy(false);
    if (ok) { setPairReq(null); toast(`已连接 ${connHost()}`, 'info'); }
  }, [pairReq, pairBusy, tryConnectBases]);

  const navTheme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(dark ? DarkTheme : DefaultTheme).colors,
      background: colors.bg,
      card: colors.bg,
      text: colors.ink,
      border: colors.line,
      primary: colors.accent,
    },
  };

  const pairOverlay = pairReq ? (
    <PairConfirm
      req={pairReq}
      busy={pairBusy}
      hasExisting={!!(token || baseUrl)}
      onConfirm={confirmPair}
      onCancel={() => setPairReq(null)}
    />
  ) : null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <BottomSheetModalProvider>
            <ConnActions.Provider value={{ tryConnect, tryConnectBases, switchDevice }}>
              <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
              {auth !== 'ok' ? (
                <ConnectScreen busy={auth === 'checking'} error={authErr} onSubmit={tryConnect} onScan={tryConnectBases} />
              ) : (
                <ProjectsProvider key={conn.key} base={conn.base}>
                <NavigationContainer ref={navigationRef} theme={navTheme} onReady={flushLink}>
                  <Drawer.Navigator
                    drawerContent={(props) => <DrawerContent {...props} />}
                    screenOptions={{
                      headerShown: false,
                      drawerType: 'front',
                      drawerStyle: { width: 320, backgroundColor: colors.bg },
                      overlayColor: 'rgba(30,26,22,0.32)',
                    }}
                  >
                    <Drawer.Screen name="Main" component={MainStack} />
                  </Drawer.Navigator>
                </NavigationContainer>
                </ProjectsProvider>
              )}
              {auth === 'ok' ? <ApprovalLayer /> : null}
              {pairOverlay}
              <ToastLayer />
            </ConnActions.Provider>
          </BottomSheetModalProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
