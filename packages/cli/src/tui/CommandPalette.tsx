import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";

import { fit } from "../format.js";

export interface PaletteCommand {
  name: string;
  label: string;
  shortcut: string;
  run: () => void;
}

export function CommandPalette({ commands, width, rows, close }: {
  commands: PaletteCommand[];
  width: number;
  rows: number;
  close: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  const matches = commands.filter(({ name, label }) => name.includes(needle) || label.includes(needle));
  const listHeight = Math.max(1, rows - 11);
  const start = Math.max(0, selected - listHeight + 1);

  useInput((_, key) => {
    if (key.escape || (key.shift && key.tab)) close();
    else if (key.upArrow) setSelected((index) => Math.max(0, index - 1));
    else if (key.downArrow) setSelected((index) => Math.min(Math.max(0, matches.length - 1), index + 1));
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold>命令面板</Text>
        <Box>
          <Text color="cyan">❯ </Text>
          <TextInput
            value={query}
            placeholder="输入命令名或用途"
            onChange={(value) => {
              setQuery(value);
              setSelected(0);
            }}
            onSubmit={() => {
              const command = matches[selected];
              if (command === undefined) return;
              close();
              command.run();
            }}
          />
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {matches.length === 0 ? <Text color="gray">没有匹配的命令</Text> : matches.slice(start, start + listHeight).map((command, index) => {
          const active = index + start === selected;
          return (
            <Text key={command.name}>
              <Text color={active ? "cyan" : "gray"} bold={active}>{active ? "❯ " : "  "}{fit(`/${command.name}`, 13)}</Text>
              <Text>{fit(command.label, width - 25)}</Text>
              <Text color="gray">{command.shortcut}</Text>
            </Text>
          );
        })}
      </Box>
      <Text color="gray"> ↑↓ 选择 · Enter 执行 · Esc 返回</Text>
    </Box>
  );
}
