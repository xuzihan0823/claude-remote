// 按内容估算列宽：中日韩字符约 1em，其余按等宽 0.6em
export function naturalColumnWidths(tok, fontSize, cellPad) {
  const textWidth = (s) => {
    let em = 0;
    for (const ch of String(s ?? '')) em += ch.codePointAt(0) >= 0x2e80 ? 1 : 0.6;
    return em * fontSize;
  };
  return tok.header.map((h, col) => {
    const widest = Math.max(textWidth(h.text), ...tok.rows.map((r) => textWidth(r[col]?.text)));
    return Math.ceil(widest + cellPad * 2 + 2);
  });
}

// 总宽超出 available 时保住短列，只收窄最长的列；列太多放不下时不低于 minWidth，交给横向滚动
export function fitColumnWidths(natural, available, minWidth) {
  const sorted = [...natural].sort((a, b) => a - b);
  let remaining = available;
  for (let i = 0; i < sorted.length; i++) {
    const share = remaining / (sorted.length - i);
    if (sorted[i] > share) {
      const cap = Math.max(share, minWidth);
      return natural.map((w) => Math.min(w, cap));
    }
    remaining -= sorted[i];
  }
  return natural;
}
