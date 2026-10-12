// 解析/序列化 USER.md、MEMORY.md 共用的小工具：非受管原文行的边界修剪。
// 段与段之间的空行分隔统一由序列化补齐，所以这里只负责把首尾空行收干净，
// 否则每轮 parse→serialize 都会多出一行空行（破坏幂等）。
export function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

/** 去掉首尾空行，中间的一律保留 */
export function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankLine(lines[start]!)) start++;
  while (end > start && isBlankLine(lines[end - 1]!)) end--;
  return lines.slice(start, end);
}

/** 只去掉尾部空行（保留开头与上一段之间的分隔空行） */
export function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && isBlankLine(lines[end - 1]!)) end--;
  return lines.slice(0, end);
}