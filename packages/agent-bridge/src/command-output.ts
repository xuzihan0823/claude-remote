export type CommandOutputPart = { stream: "stdout" | "stderr" | "output"; text: string };

export function commandOutputParts(text: string): CommandOutputPart[] {
  const sanitized = stripCommandNoise(text);
  return [...sanitized.matchAll(/<local-command-(stdout|stderr)(?:\s[^>]*)?>([\s\S]*?)<\/local-command-\1>/g)]
    .flatMap((match) => {
      const text = match[2];
      return text?.trim() ? [{ stream: match[1] === "stderr" ? "stderr" as const : "stdout" as const, text }] : [];
    });
}

export function stripCommandNoise(text: string): string {
  return text.replace(/<(task-notification|system-reminder)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "");
}

export function localCommandOutput(text: string): CommandOutputPart[] {
  const parts = commandOutputParts(text);
  if (parts.length > 0) return parts;
  const clean = stripCommandNoise(text);
  return clean.trim() && !/<local-command-(stdout|stderr)(?:\s|>)/.test(clean) ? [{ stream: "output", text: clean }] : [];
}
