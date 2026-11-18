import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";

import { fit } from "../format.js";
import { checkRelaySecret, parseRelayUrl } from "../relay.js";

export function RelayForm({ width, save }: { width: number; save: (url: string, secret: string) => void }): React.JSX.Element {
  const [address, setAddress] = useState<string>();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function submit(text: string): void {
    if (address === undefined) {
      try {
        setAddress(parseRelayUrl(text.trim()));
      } catch {
        setError("请输入有效的 Relay 地址，公网地址须使用 HTTPS");
        return;
      }
      setValue("");
      setError("");
      return;
    }
    const secret = text.trim();
    try {
      checkRelaySecret(secret);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Relay 密钥无效");
      return;
    }
    setValue("");
    save(address, secret);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>/relay add</Text>
      {address === undefined ? (
        <Text color="gray">请输入你信任的 Relay 地址。已有同一地址时会更新密钥。</Text>
      ) : (
        <Text color="gray">{fit(address, width - 2, false)}</Text>
      )}
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color="cyan">{address === undefined ? "地址 ❯ " : "密钥 ❯ "}</Text>
        <TextInput
          key={address === undefined ? "address" : "secret"}
          value={value}
          onChange={setValue}
          placeholder={address === undefined ? "https://relay.example.com" : "服务器的 RELAY_SECRET"}
          {...(address === undefined ? {} : { mask: "*" })}
          onSubmit={submit}
        />
      </Box>
      {error !== "" && <Text color="red">{error}</Text>}
      <Text color="gray">Enter {address === undefined ? "下一步" : "检查并保存"} · Esc 取消</Text>
    </Box>
  );
}
