export type DiffRow = {
  type: "same" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
};
export type DiffPiece = DiffRow | { type: "gap"; hidden: number };
// Above this many cells the LCS table is skipped and the changed middle is
// shown as a block replacement. Algorithm solutions stay far below it.
const MAX_CELLS = 4_000_000;
const lines = (value: string) =>
  value === "" ? [] : value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
export function diffLines(before: string, after: string): DiffRow[] {
  const a = lines(before),
    b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB);
  const ops: DiffRow["type"][] = [];
  if (midA.length * midB.length > MAX_CELLS) {
    ops.push(...midA.map(() => "del" as const), ...midB.map(() => "add" as const));
  } else {
    const n = midA.length,
      m = midB.length,
      width = m + 1,
      table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push("same");
        i++;
        j++;
      } else if (
        i < n &&
        (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])
      ) {
        ops.push("del");
        i++;
      } else {
        ops.push("add");
        j++;
      }
    }
  }
  const rows: DiffRow[] = [];
  let oldNo = 0,
    newNo = 0;
  const same = () => {
    oldNo++;
    newNo++;
    rows.push({ type: "same", text: b[newNo - 1], oldNo, newNo });
  };
  for (let k = 0; k < start; k++) same();
  for (const op of ops) {
    if (op === "same") same();
    else if (op === "del") {
      oldNo++;
      rows.push({ type: "del", text: a[oldNo - 1], oldNo });
    } else {
      newNo++;
      rows.push({ type: "add", text: b[newNo - 1], newNo });
    }
  }
  while (newNo < b.length) same();
  return rows;
}
export function withContext(rows: DiffRow[], context = 3): DiffPiece[] {
  const keep = rows.map(() => false);
  rows.forEach((row, index) => {
    if (row.type === "same") return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(rows.length - 1, index + context);
      k++
    )
      keep[k] = true;
  });
  const pieces: DiffPiece[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (hidden) pieces.push({ type: "gap", hidden });
      hidden = 0;
      pieces.push(row);
    } else hidden++;
  });
  if (hidden && pieces.length) pieces.push({ type: "gap", hidden });
  return pieces;
}
export const diffStat = (rows: DiffRow[]) => ({
  added: rows.filter((r) => r.type === "add").length,
  removed: rows.filter((r) => r.type === "del").length,
});
