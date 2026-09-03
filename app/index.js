// 顺序敏感：storage shim 必须先于任何 core 模块执行（core/api.js 模块加载期读 localStorage）
import './src/lib/storage';
import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import App from './src/App';

registerRootComponent(App);
