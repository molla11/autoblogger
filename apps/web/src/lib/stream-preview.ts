/** Extract displayable strings from cumulative structured output without exposing JSON wiring. */
export function draftPreview(source: string): {
  title: string;
  paragraphs: string[];
} {
  const values = (key: string) => {
    const output: string[] = [];
    const pattern = new RegExp(`"${key}"\\s*:\\s*"`, "g");
    let found: RegExpExecArray | null;
    while ((found = pattern.exec(source))) {
      let raw = "",
        escaped = false;
      for (let i = pattern.lastIndex; i < source.length; i++) {
        const char = source[i];
        if (char === '"' && !escaped) break;
        raw += char;
        if (char === "\\" && !escaped) escaped = true;
        else escaped = false;
      }
      // A network chunk may end in the middle of an escape; keep all preceding text.
      let value = raw;
      for (let trim = 0; trim <= 6; trim++) {
        try {
          value = JSON.parse('"' + raw.slice(0, raw.length - trim) + '"');
          break;
        } catch {
          if (trim === 6) value = "";
        }
      }
      if (value) output.push(value);
    }
    return output;
  };
  return { title: values("title")[0] || "", paragraphs: values("text") };
}
