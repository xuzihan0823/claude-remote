import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createDrawerNavigator } from '@react-navigation/drawer';
import * as Linking from 'expo-linking';

import {
  baseUrl, BASE_KEY, clearToken, connErrMsg, connHost, loadBases, normalizeBase,
  pendingSessionMessages, probeBase, probeBases, saveBases, saveConn, sessionCache, token, TOKEN_KEY,
} from '../../web/core/api.js';
import { toast, useBus } from '../../web/core/bus.js';
import { ws } from '../../web/core/ws.js';
import { parseSetupLink } from './lib/pairing.js';
import { ConnActions } from './lib/conn-context.js';
import { ProjectsProvider } from './lib/projects-context.js';
import { useTheme } from './theme.js';
import { ConnectScreen } from './screens/ConnectScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { ChatScreen } from './screens/ChatScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { DrawerContent } from './components/DrawerContent.js';
import { PairConfirm } from './components/PairConfirm.js';
import { ApprovalLayer } from './components/ApprovalLayer.js';
import { ToastLayer } from './components/Toast.js';

const Stack = createNativeStackNavigator();
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
      <Stack.Screen name="Settings" component={SettingsScreen} />
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

  const tryConnect = useCallback(async (base, tok) => {
    setAuth((a) => (a === 'ok' ? 'ok' : 'checking'));
    setAuthErr('');
    const nextBase = normalizeBase(base);
    try {
      await probeBase(nextBase, tok);
      saveConn(nextBase, tok);
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
  }, [commitConn]);

  const tryConnectBases = useCallback(async (bases, tok) => {
    setAuth((a) => (a === 'ok' ? 'ok' : 'checking'));
    setAuthErr('');
    try {
      const base = await probeBases(bases, tok);
      saveBases(bases);
      saveConn(base, tok);
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
  }, [commitConn]);

  // 启动自动重连：优先多候选探测（扫码配对存的 bases），退回单地址
  useEffect(() => {
    if (!token) return;
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

  // claude-remote://setup 深链（冷启动 + 运行中）
  const [pairReq, setPairReq] = useState(null);
  const [pairBusy, setPairBusy] = useState(false);
  const handleUrl = useCallback((url) => {
    if (!url || !url.startsWith('claude-remote:')) return;
    const req = parseSetupLink(url);
    if (req) setPairReq(req);
    else toast('无法识别的配对链接', 'error');
  }, []);
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
            <ConnActions.Provider value={{ tryConnect, tryConnectBases }}>
              <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
              {auth !== 'ok' ? (
                <ConnectScreen busy={auth === 'checking'} error={authErr} onSubmit={tryConnect} />
              ) : (
                <ProjectsProvider key={conn.key} base={conn.base}>
                <NavigationContainer theme={navTheme}>
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
