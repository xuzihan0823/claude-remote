import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '../theme.js';

const paths = {
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7',
  laptop: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5V16H4V6.5A1.5 1.5 0 0 1 5.5 5ZM2 19h20',
  qr: 'M5 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM15 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM5 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1ZM14 14h2v2M20 14v6h-4M14 18v2',
  appearance: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 3v18M12 7h4.5M12 11h6.5M12 15h6M12 19h3',
  textSize: 'M3.5 19 8.5 5l5 14M5.3 14h6.4M14.5 19l3-8 3 8M15.4 16.5h4.2',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
  shieldCheck: 'M12 3.5 5.5 6v5.2c0 4.1 2.7 7.6 6.5 9.3 3.8-1.7 6.5-5.2 6.5-9.3V6zM9 12l2 2 4-4',
  haptic: 'M10 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM4 8l-1.5 2L4 12l-1.5 2L4 16M20 8l1.5 2-1.5 2 1.5 2-1.5 2',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6M12 17v.01',
  github: 'M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5a3 3 0 0 0-.8-2.3c2.8-.3 5.8-1.4 5.8-6.2a4.8 4.8 0 0 0-1.3-3.3 4.4 4.4 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 2.1 5.6 2.4 5.6 2.4a4.4 4.4 0 0 0-.1 3.3A4.8 4.8 0 0 0 4.2 9c0 4.8 3 5.9 5.8 6.2a3 3 0 0 0-.8 2.3V21',
  wrap: 'M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M4 18h5M14 16l-2 2 2 2',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V6a2 2 0 0 0-3-2ZM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
  tool: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11 12l8-8M16 7l2 2M14 9l2 2',
  tag: 'M3 12V4h8l10 10-8 8ZM7.5 9.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6h4',
  menu: 'M4 6h16M4 12h12M4 18h7',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  camera: 'M3.5 8.5A1.5 1.5 0 0 1 5 7h2.5l1.5-2.5h6L16.5 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5ZM12 15.8a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6Z',
  image: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM4 16.5l4.5-4.5 7.5 8M15 10.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  paperclip: 'M16 8v8.5a4 4 0 0 1-8 0V7a2.5 2.5 0 0 1 5 0v9.5a1 1 0 0 1-2 0V8',
  send: 'M12 19V5m-6 6 6-6 6 6',
  arrowDown: 'M12 5v14m-6-6 6 6 6-6',
  back: 'm14 5-7 7 7 7',
  chevron: 'm8 10 4 4 4-4',
  chevronUp: 'm8 14 4-4 4 4',
  chevronRight: 'm10 8 4 4-4 4',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 7.5v.01',
  shield: 'M12 3.5 5.5 6v5.2c0 4.1 2.7 7.6 6.5 9.3 3.8-1.7 6.5-5.2 6.5-9.3V6z',
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  newChat: 'M11.5 4.2H7.6A3.4 3.4 0 0 0 4.2 7.6v8.8a3.4 3.4 0 0 0 3.4 3.4h8.8a3.4 3.4 0 0 0 3.4-3.4V12.5M16.5 3.8a2.12 2.12 0 0 1 3 3L13 13.3c-.45.45-1.02.75-1.64.88l-2.16.44.44-2.16c.13-.62.43-1.19.88-1.64l6-6.02ZM15.1 5.2l2.9 2.9',
  share: 'M12 15V3m-4 4 4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  scan: 'M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M7 12h10',
  refresh: 'M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.05 1.51 1.09H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  terminal: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6ZM7.5 9.5 10.5 12l-3 2.5M12.5 15h4',
  fileText: 'M14 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L14 3.5ZM14 3.5v5h5M8.5 13h7M8.5 16.5h4.5',
  fileEdit: 'M13 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M16.5 3.8a1.8 1.8 0 0 1 2.5 2.5L12.5 13H10v-2.5l6.5-6.7Z',
  checklist: 'm4.5 7.5 1.8 1.8 3.2-3.3M12 8h7.5M4.5 15.5l1.8 1.8 3.2-3.3M12 16h7.5',
};

export function toolIconName(toolName) {
  switch (toolName) {
    case 'Bash':
      return 'terminal';
    case 'Read':
      return 'fileText';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'fileEdit';
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
      return 'search';
    case 'TodoWrite':
      return 'checklist';
    case 'WebFetch':
    case 'WebSearch':
      return 'globe';
    case 'Task':
    case 'TaskWait':
    case 'AskUserQuestion':
      return 'help';
    case 'TaskList':
    case 'TaskStop':
      return 'spark';
    default:
      return 'tool';
  }
}

export function Icon({ name, size = 22, color, strokeWidth = 1.8 }) {
  const { colors } = useTheme();
  const ink = color || colors.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {name === 'more' ? [5, 12, 19].map((cx) => <Circle key={cx} cx={cx} cy={12} r={1.7} fill={ink} />)
        : name === 'stop' ? <Path d="M7 7h10v10H7z" fill={ink} />
          : <Path d={paths[name]} stroke={ink} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />}
    </Svg>
  );
}
